// 体测只读查询：只读已发布快照，按 generation 固定可见版本；分页、字节预算、大记录分块。

import { type CursorState, decodeCursor, encodeCursor, queryHash } from './cursor'
import type { ToolContext, ToolOutcome } from './mcp'
import { type Dataset, JOIN_RULES_VERIFIED } from './measurements'
import { SYNC_POLICY } from './sync'
import {
  byteLength,
  DEFAULT_TIMEZONE,
  encoder,
  isoInZone,
  isValidTimeZone,
  KtError,
  localDate,
  parseInstant,
  parseLossless,
  sha256Hex,
} from './util'

export const PAGE_BYTE_BUDGET = 200 * 1024
export const OUTPUT_INLINE_BYTES = 64 * 1024
export const OUTPUT_CHUNK_BYTES = 24 * 1024
const MAX_SORT = 9007199254740991
const DAY_MS = 86_400_000

export interface VersionRow {
  id: string
  raw_record_id: string
  dataset: Dataset
  profile_ref: string
  raw_hash: string
  byte_length: number
  raw_json: string | null
  chunk_count: number
  measured_at: number | null
  local_date: string | null
  is_deleted: number | null
  source_data_id: string | null
  imp_data_id: string | null
  balance_data_id: string | null
  gravity_data_id: string | null
  metrics_json: string
  ext_parse_status: string
  quality_flags_json: string
}

/** 在 generation 快照下，每条 raw 记录只取最新的已发布版本。?1 = generation。 */
export const VISIBLE = `v.published = 1 AND v.generation <= ?1 AND NOT EXISTS (
  SELECT 1 FROM raw_record_versions n WHERE n.raw_record_id = v.raw_record_id AND n.published = 1
  AND n.generation <= ?1 AND (n.generation > v.generation OR (n.generation = v.generation AND n.stage_index > v.stage_index)))`

export interface Snapshot {
  generation: number
  stale: boolean
  syncedAt: string | null
}

export async function readSnapshot(db: D1Database, ownerId: string, nowMs: number): Promise<Snapshot> {
  const meta = await db
    .prepare(
      'SELECT published_generation, last_published_at, last_attempt_at, last_error_code FROM sync_meta WHERE owner_id = ?',
    )
    .bind(ownerId)
    .first<{
      published_generation: number
      last_published_at: number | null
      last_attempt_at: number | null
      last_error_code: string | null
    }>()
  if (!meta || meta.last_published_at === null) {
    return { generation: meta?.published_generation ?? 0, stale: true, syncedAt: null }
  }
  const failedSince = meta.last_error_code !== null && (meta.last_attempt_at ?? 0) > meta.last_published_at
  return {
    generation: meta.published_generation,
    stale: failedSince || nowMs - meta.last_published_at > SYNC_POLICY.staleAfterMs,
    syncedAt: isoInZone(meta.last_published_at, DEFAULT_TIMEZONE),
  }
}

export interface Range {
  startMs: number
  endMs: number
  timezone: string
}

export function parseRange(args: { start: string; end: string; timezone?: string }, maxDays = 366): Range {
  const startMs = parseInstant(args.start)
  const endMs = parseInstant(args.end)
  if (startMs === null || endMs === null || endMs <= startMs || endMs - startMs > maxDays * DAY_MS) {
    throw new KtError('INVALID_RANGE')
  }
  const timezone = args.timezone ?? DEFAULT_TIMEZONE
  if (!isValidTimeZone(timezone)) throw new KtError('INVALID_INPUT', { category: 'timezone' })
  return { startMs, endMs, timezone }
}

/** 半开区间 [start,end) 的毫秒边界换算为秒级 measured_at 边界。 */
export const secondsBounds = (range: Range) =>
  [Math.ceil(range.startMs / 1000), Math.ceil(range.endMs / 1000)] as const

export async function resolveProfile(
  db: D1Database,
  ownerId: string,
  profileRef?: string,
): Promise<string | null> {
  if (profileRef) {
    const hit = await db
      .prepare(
        `SELECT 1 FROM profiles WHERE owner_id = ?1 AND profile_ref = ?2
         UNION SELECT 1 FROM raw_record_versions WHERE owner_id = ?1 AND profile_ref = ?2 AND published = 1 LIMIT 1`,
      )
      .bind(ownerId, profileRef)
      .first()
    if (!hit) throw new KtError('NOT_FOUND')
    return profileRef
  }
  const rows = await db
    .prepare('SELECT profile_ref FROM profiles WHERE owner_id = ? ORDER BY profile_ref LIMIT 2')
    .bind(ownerId)
    .all<{ profile_ref: string }>()
  if (rows.results.length > 1) throw new KtError('PROFILE_REQUIRED')
  return rows.results[0]?.profile_ref ?? null
}

const flagsOf = (row: VersionRow): string[] => {
  const flags = JSON.parse(row.quality_flags_json) as string[]
  if (row.is_deleted === 1) flags.push('tombstone')
  return flags
}

export function toRawRecord(row: VersionRow) {
  const inline = row.raw_json !== null && row.byte_length <= OUTPUT_INLINE_BYTES
  return {
    record_ref: row.raw_record_id,
    version_ref: row.id,
    dataset: row.dataset,
    profile_ref: row.profile_ref,
    raw_hash: row.raw_hash,
    byte_length: row.byte_length,
    raw_json: inline ? row.raw_json : null,
    complete: inline,
    chunk_ref: inline ? null : row.id,
    is_deleted: row.is_deleted === null ? null : row.is_deleted === 1,
    quality_flags: flagsOf(row),
  }
}

function derivedMetrics(metrics: Record<string, number | null>, flags: string[]) {
  const out = { ...metrics }
  const weight = metrics.weight_kg
  const bfr = metrics.body_fat_pct
  if (typeof weight === 'number' && typeof bfr === 'number') {
    if (bfr > 0) {
      out.fat_mass_kg = (weight * bfr) / 100
      out.fat_free_mass_kg = weight - out.fat_mass_kg
    } else flags.push('body_fat_zero_unverified')
  }
  return out
}

export function toSummary(row: VersionRow, timezone: string) {
  const flags = flagsOf(row)
  const metrics = derivedMetrics(JSON.parse(row.metrics_json) as Record<string, number | null>, flags)
  return {
    record_ref: row.raw_record_id,
    profile_ref: row.profile_ref,
    measured_at: row.measured_at === null ? null : isoInZone(row.measured_at * 1000, timezone),
    local_date: row.measured_at === null ? null : localDate(row.measured_at * 1000, timezone),
    metrics,
    quality_flags: [...new Set(flags)],
  }
}

const RELATIONS: [Dataset, keyof VersionRow | null][] = [
  ['impedance', 'imp_data_id'],
  ['hr', null],
  ['balance', 'balance_data_id'],
  ['gravity', 'gravity_data_id'],
]

async function relationRows(
  db: D1Database,
  ownerId: string,
  generation: number,
  dataset: Dataset,
  profileRef: string,
  foreignKey: string,
  includeDeleted: boolean,
  limit: number,
): Promise<VersionRow[]> {
  const rows = await db
    .prepare(
      `SELECT v.* FROM raw_record_versions v WHERE ${VISIBLE} AND v.owner_id = ?2 AND v.dataset = ?3
       AND v.source_data_id = ?4 AND (v.profile_ref = ?5 OR v.profile_ref = 'p_unknown')
       ${includeDeleted ? '' : 'AND v.is_deleted = 0'} ORDER BY v.raw_record_id, v.id LIMIT ?6`,
    )
    .bind(generation, ownerId, dataset, foreignKey, profileRef, limit)
    .all<VersionRow>()
  return rows.results
}

export async function toMeasurement(
  db: D1Database,
  ownerId: string,
  generation: number,
  row: VersionRow,
  includeDeleted: boolean,
) {
  const weight = toRawRecord(row)
  let extRaw: string | null = null
  let extParsed: unknown = null
  let complete = weight.complete
  if (row.raw_json !== null) {
    const record = parseLossless(row.raw_json) as Record<string, unknown>
    const ext = record.ext_data
    if (typeof ext === 'string') {
      // ext_data 原文与解析各带一份；超过内联上限时两者都不内联，从 weight.raw_json（或其 chunk_ref）读取。
      if (byteLength(ext) <= OUTPUT_INLINE_BYTES / 2) {
        extRaw = ext
        if (row.ext_parse_status === 'ok') extParsed = parseLossless(ext)
      } else complete = false
    }
  } else complete = false

  const relations = []
  let relationBudget = OUTPUT_INLINE_BYTES
  for (const [dataset, column] of RELATIONS) {
    const fk = column ? (row[column] as string | null) : null
    if (!column || !fk) {
      relations.push({ dataset, status: 'not_applicable' as const, records: [], next_cursor: null })
      continue
    }
    const matches = await relationRows(
      db,
      ownerId,
      generation,
      dataset,
      row.profile_ref,
      fk,
      includeDeleted,
      51,
    )
    if (matches.length > 50) complete = false
    // 关联记录共用一个内联预算，超出部分只给 chunk_ref，避免一次体测因附属记录过多而整体超限。
    const records = matches.slice(0, 50).map((match) => {
      const record = toRawRecord(match)
      if (record.complete && match.byte_length <= relationBudget) {
        relationBudget -= match.byte_length
        return record
      }
      return { ...record, raw_json: null, complete: false, chunk_ref: match.id }
    })
    if (records.some((r) => !r.complete)) complete = false
    const status =
      matches.length === 0
        ? 'missing'
        : matches.length > 1
          ? 'ambiguous'
          : JOIN_RULES_VERIFIED
            ? 'exact'
            : 'unverified'
    relations.push({ dataset, status, records, next_cursor: null })
  }
  return {
    weight,
    ext_data_raw: extRaw,
    ext_data_parsed: extParsed,
    ext_parse_status: row.ext_parse_status,
    relations,
    complete,
  }
}

// ───────────── 工具处理函数 ─────────────

const bodyContext = async (ctx: ToolContext) => readSnapshot(ctx.env.DB, ctx.ownerId, ctx.deps.now())

export async function getLatestMeasurementFull(
  args: { profile_ref?: string; include_deleted?: boolean },
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const db = ctx.env.DB
  const snap = await bodyContext(ctx)
  const profile = await resolveProfile(db, ctx.ownerId, args.profile_ref)
  const includeDeleted = args.include_deleted ?? false
  const row = await db
    .prepare(
      `SELECT v.* FROM raw_record_versions v WHERE ${VISIBLE} AND v.owner_id = ?2 AND v.dataset = 'weight'
       AND v.measured_at IS NOT NULL ${profile ? 'AND v.profile_ref = ?3' : 'AND ?3 IS NULL'}
       ${includeDeleted ? '' : 'AND v.is_deleted = 0'}
       ORDER BY v.measured_at DESC, v.raw_record_id DESC LIMIT 1`,
    )
    .bind(snap.generation, ctx.ownerId, profile)
    .first<VersionRow>()
  const base = { stale: snap.stale, syncedAt: snap.syncedAt }
  if (!row) return { ...base, data: null, summary: '本地镜像中没有体测记录。' }
  const measurement = await toMeasurement(db, ctx.ownerId, snap.generation, row, includeDeleted)
  const summary = toSummary(row, DEFAULT_TIMEZONE)
  return {
    ...base,
    data: measurement,
    summary: `最新体测 ${summary.measured_at}${snap.stale ? '（数据可能已过期）' : ''}。`,
  }
}

async function pageState(ctx: ToolContext, tool: string, args: Record<string, unknown>) {
  const query = await queryHash(args)
  const now = ctx.deps.now()
  let state: CursorState | null = null
  if (typeof args.cursor === 'string')
    state = await decodeCursor(ctx.env, ctx.ownerId, tool, query, args.cursor, now)
  return { query, state }
}

interface MeasurementArgs {
  start: string
  end: string
  timezone?: string
  limit?: number
  cursor?: string
  profile_ref?: string
  include_deleted?: boolean
  detail?: 'summary' | 'full'
}

export async function getMeasurements(args: MeasurementArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const db = ctx.env.DB
  const range = parseRange(args)
  const detail = args.detail ?? 'summary'
  const limit = args.limit ?? (detail === 'full' ? 10 : 50)
  if (detail === 'full' && limit > 25) throw new KtError('INVALID_INPUT', { category: 'full_limit' })
  const { query, state } = await pageState(
    ctx,
    'get_measurements',
    args as unknown as Record<string, unknown>,
  )
  const snap = await bodyContext(ctx)
  const generation = state?.snapshot ?? snap.generation
  const profile = await resolveProfile(db, ctx.ownerId, args.profile_ref)
  const [from, to] = secondsBounds(range)
  const key = state?.key ?? [-1, '', '']
  const rows = await db
    .prepare(
      `SELECT v.* FROM raw_record_versions v WHERE ${VISIBLE} AND v.owner_id = ?2 AND v.dataset = 'weight'
       AND v.measured_at >= ?3 AND v.measured_at < ?4 ${profile ? 'AND v.profile_ref = ?5' : 'AND ?5 IS NULL'}
       ${args.include_deleted ? '' : 'AND v.is_deleted = 0'}
       AND (v.measured_at, v.raw_record_id, v.id) > (?6, ?7, ?8)
       ORDER BY v.measured_at, v.raw_record_id, v.id LIMIT ?9`,
    )
    .bind(generation, ctx.ownerId, from, to, profile, key[0], key[1], key[2], limit + 1)
    .all<VersionRow>()

  const items: unknown[] = []
  let used = 0
  let last: VersionRow | null = null
  let more = rows.results.length > limit
  for (const row of rows.results.slice(0, limit)) {
    const item =
      detail === 'full'
        ? await toMeasurement(db, ctx.ownerId, generation, row, args.include_deleted ?? false)
        : toSummary(row, range.timezone)
    const size = byteLength(JSON.stringify(item))
    if (items.length > 0 && used + size > PAGE_BYTE_BUDGET) {
      more = true
      break
    }
    items.push(item)
    used += size
    last = row
  }
  const nextCursor =
    more && last
      ? await encodeCursor(
          ctx.env,
          ctx.ownerId,
          'get_measurements',
          query,
          { snapshot: generation, key: [last.measured_at ?? MAX_SORT, last.raw_record_id, last.id] },
          ctx.deps.now(),
        )
      : null
  return {
    data: items,
    stale: snap.stale,
    syncedAt: snap.syncedAt,
    nextCursor,
    summary: `返回 ${items.length} 条体测（${detail}）${nextCursor ? '，还有下一页' : ''}。`,
  }
}

interface RawDatasetArgs extends Omit<MeasurementArgs, 'detail'> {
  dataset: Dataset
  measurement_ref?: string
}

const FOREIGN_KEY: Partial<Record<Dataset, keyof VersionRow>> = {
  impedance: 'imp_data_id',
  balance: 'balance_data_id',
  gravity: 'gravity_data_id',
}

export async function getRawDataset(args: RawDatasetArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const db = ctx.env.DB
  const range = parseRange(args)
  const limit = args.limit ?? 25
  if (limit > 100) throw new KtError('INVALID_INPUT', { category: 'raw_limit' })
  const { query, state } = await pageState(ctx, 'get_raw_dataset', args as unknown as Record<string, unknown>)
  const snap = await bodyContext(ctx)
  const generation = state?.snapshot ?? snap.generation
  const profile = await resolveProfile(db, ctx.ownerId, args.profile_ref)
  const [from, to] = secondsBounds(range)

  let relationFilter = 'AND ?10 IS NULL AND ?12 IS NULL'
  let relationKey: string | null = null
  let relationProfile: string | null = null
  if (args.measurement_ref) {
    const weight = await db
      .prepare(
        `SELECT v.* FROM raw_record_versions v WHERE ${VISIBLE} AND v.owner_id = ?2 AND v.raw_record_id = ?3 AND v.dataset = 'weight'`,
      )
      .bind(generation, ctx.ownerId, args.measurement_ref)
      .first<VersionRow>()
    if (!weight) throw new KtError('NOT_FOUND')
    const column = FOREIGN_KEY[args.dataset]
    relationKey = column ? (weight[column] as string | null) : null
    if (!relationKey)
      return {
        data: [],
        stale: snap.stale,
        syncedAt: snap.syncedAt,
        summary: '该体测没有此数据集的关联外键。',
      }
    relationProfile = weight.profile_ref
    relationFilter = "AND v.source_data_id = ?10 AND (v.profile_ref = ?12 OR v.profile_ref = 'p_unknown')"
  }

  const key = state?.key ?? [-1, '', '']
  const rows = await db
    .prepare(
      `SELECT v.* FROM raw_record_versions v WHERE ${VISIBLE} AND v.owner_id = ?2 AND v.dataset = ?3
       AND ((v.measured_at >= ?4 AND v.measured_at < ?5) OR v.measured_at IS NULL)
       ${profile ? "AND (v.profile_ref = ?6 OR v.profile_ref = 'p_unknown')" : 'AND ?6 IS NULL'}
       ${args.include_deleted ? '' : 'AND (v.is_deleted = 0)'} ${relationFilter}
       AND (COALESCE(v.measured_at, ${MAX_SORT}), v.raw_record_id, v.id) > (?7, ?8, ?9)
       ORDER BY COALESCE(v.measured_at, ${MAX_SORT}), v.raw_record_id, v.id LIMIT ?11`,
    )
    .bind(
      generation,
      ctx.ownerId,
      args.dataset,
      from,
      to,
      profile,
      key[0],
      key[1],
      key[2],
      relationKey,
      limit + 1,
      relationProfile,
    )
    .all<VersionRow>()

  const items: ReturnType<typeof toRawRecord>[] = []
  let used = 0
  let last: VersionRow | null = null
  let more = rows.results.length > limit
  for (const row of rows.results.slice(0, limit)) {
    const item = toRawRecord(row)
    const size = byteLength(JSON.stringify(item))
    if (items.length > 0 && used + size > PAGE_BYTE_BUDGET) {
      more = true
      break
    }
    items.push(item)
    used += size
    last = row
  }
  const nextCursor =
    more && last
      ? await encodeCursor(
          ctx.env,
          ctx.ownerId,
          'get_raw_dataset',
          query,
          { snapshot: generation, key: [last.measured_at ?? MAX_SORT, last.raw_record_id, last.id] },
          ctx.deps.now(),
        )
      : null
  return {
    data: items,
    stale: snap.stale,
    syncedAt: snap.syncedAt,
    nextCursor,
    summary: `返回 ${items.length} 条 ${args.dataset} 原始记录${nextCursor ? '，还有下一页' : ''}。`,
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export async function getRawRecordChunk(
  args: { version_ref: string; chunk_index: number },
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const db = ctx.env.DB
  const row = await db
    .prepare(
      'SELECT id, raw_json, raw_hash, byte_length, chunk_count FROM raw_record_versions WHERE id = ? AND owner_id = ? AND published = 1',
    )
    .bind(args.version_ref, ctx.ownerId)
    .first<{
      id: string
      raw_json: string | null
      raw_hash: string
      byte_length: number
      chunk_count: number
    }>()
  if (!row) throw new KtError('NOT_FOUND')
  let bytes: Uint8Array
  if (row.raw_json !== null) bytes = encoder.encode(row.raw_json)
  else {
    const parts = await db
      .prepare('SELECT data FROM raw_chunks WHERE version_id = ? ORDER BY chunk_index')
      .bind(row.id)
      .all<{ data: ArrayBuffer | number[] }>()
    bytes = new Uint8Array(row.byte_length)
    let offset = 0
    for (const part of parts.results) {
      const chunk = part.data instanceof ArrayBuffer ? new Uint8Array(part.data) : Uint8Array.from(part.data)
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    if (offset !== row.byte_length) throw new KtError('STORAGE_FAILED', { category: 'chunk_length_mismatch' })
  }
  const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / OUTPUT_CHUNK_BYTES))
  if (args.chunk_index >= chunkCount) throw new KtError('NOT_FOUND')
  const part = bytes.slice(args.chunk_index * OUTPUT_CHUNK_BYTES, (args.chunk_index + 1) * OUTPUT_CHUNK_BYTES)
  return {
    data: {
      data_base64: toBase64(part),
      chunk_index: args.chunk_index,
      chunk_count: chunkCount,
      record_sha256: row.raw_hash,
      chunk_sha256: await sha256Hex(part),
    },
    summary: `第 ${args.chunk_index + 1}/${chunkCount} 块。`,
  }
}

export async function getSyncStatus(_args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const db = ctx.env.DB
  const snap = await bodyContext(ctx)
  const meta = await db
    .prepare('SELECT last_published_at, last_attempt_at, last_error_code FROM sync_meta WHERE owner_id = ?')
    .bind(ctx.ownerId)
    .first<{
      last_published_at: number | null
      last_attempt_at: number | null
      last_error_code: string | null
    }>()
  const latest = await db
    .prepare('SELECT id, state FROM sync_batches WHERE owner_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(ctx.ownerId)
    .first<{ id: string; state: string }>()
  const published = await db
    .prepare(
      "SELECT coverage, counts_json FROM sync_batches WHERE owner_id = ? AND state IN ('published', 'partial') ORDER BY created_at DESC LIMIT 1",
    )
    .bind(ctx.ownerId)
    .first<{ coverage: 'unknown' | 'partial' | 'verified_window'; counts_json: string | null }>()
  const stored = await db
    .prepare(
      'SELECT dataset, COUNT(DISTINCT raw_record_id) AS n FROM raw_record_versions WHERE owner_id = ? AND published = 1 GROUP BY dataset',
    )
    .bind(ctx.ownerId)
    .all<{ dataset: string; n: number }>()
  const counts: Record<string, number> = Object.fromEntries(stored.results.map((r) => [r.dataset, r.n]))
  const lastBatchCounts = published?.counts_json
    ? (JSON.parse(published.counts_json) as Record<string, number>)
    : {}
  if (typeof lastBatchCounts.blocked === 'number') counts.blocked_last_batch = lastBatchCounts.blocked
  const state = !latest
    ? 'empty'
    : latest.state === 'queued' || latest.state === 'staging'
      ? 'staging'
      : (latest.state as 'published' | 'partial' | 'failed')
  const iso = (ms: number | null | undefined) => (ms == null ? null : isoInZone(ms, DEFAULT_TIMEZONE))
  return {
    data: {
      last_success_at: iso(meta?.last_published_at),
      last_attempt_at: iso(meta?.last_attempt_at),
      batch_id: latest?.id ?? null,
      state,
      coverage: published?.coverage ?? 'unknown',
      counts,
      error_code: meta?.last_error_code ?? null,
    },
    stale: snap.stale,
    syncedAt: snap.syncedAt,
    summary: `同步状态：${state}${snap.stale ? '，数据可能已过期' : ''}。`,
  }
}

async function listProjection(
  ctx: ToolContext,
  args: { limit?: number; cursor?: string },
  tool: 'list_profiles' | 'list_devices',
): Promise<ToolOutcome> {
  const limit = args.limit ?? 50
  const { query, state } = await pageState(ctx, tool, args)
  const after = String(state?.key[0] ?? '')
  const sql =
    tool === 'list_profiles'
      ? 'SELECT profile_ref AS ref, label FROM profiles WHERE owner_id = ? AND profile_ref > ? ORDER BY profile_ref LIMIT ?'
      : 'SELECT device_ref AS ref, model, firmware FROM devices WHERE owner_id = ? AND device_ref > ? ORDER BY device_ref LIMIT ?'
  const rows = await ctx.env.DB.prepare(sql)
    .bind(ctx.ownerId, after, limit + 1)
    .all<{ ref: string; label?: string | null; model?: string | null; firmware?: string | null }>()
  const page = rows.results.slice(0, limit)
  const data =
    tool === 'list_profiles'
      ? page.map((r) => ({ profile_ref: r.ref, label: r.label ?? '未命名成员' }))
      : page.map((r) => ({ device_ref: r.ref, model: r.model ?? null, firmware: r.firmware ?? null }))
  const lastRef = page.at(-1)?.ref
  const nextCursor =
    rows.results.length > limit && lastRef
      ? await encodeCursor(ctx.env, ctx.ownerId, tool, query, { snapshot: 0, key: [lastRef] }, ctx.deps.now())
      : null
  const snap = await bodyContext(ctx)
  return { data, nextCursor, stale: snap.stale, syncedAt: snap.syncedAt, summary: `返回 ${data.length} 项。` }
}

export const listProfiles = (args: { limit?: number; cursor?: string }, ctx: ToolContext) =>
  listProjection(ctx, args, 'list_profiles')
export const listDevices = (args: { limit?: number; cursor?: string }, ctx: ToolContext) =>
  listProjection(ctx, args, 'list_devices')
