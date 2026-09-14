// 测量链：响应原文 → 保真解析 → 测量白名单 + 秘密阻断 → raw 版本/分块 + 索引投影 → 暂存 → 原子发布。

import type { CapturedWindow } from './fitdays'
import { collectSecretValues } from './fitdays'
import { type BlockedItem, isSuspiciousValue, SANITIZER_VERSION, sanitizeRecord } from './sanitize'
import {
  byteLength,
  canonicalStringify,
  DEFAULT_TIMEZONE,
  encoder,
  isRawNumber,
  KtError,
  localDate,
  parseLossless,
  sha256Hex,
} from './util'

export const DATASETS = [
  'weight',
  'impedance',
  'hr',
  'balance',
  'gravity',
  'height',
  'rulers',
  'skip',
] as const
export type Dataset = (typeof DATASETS)[number]

export const RAW_FORMAT_VERSION = 1
export const FORMULA_VERSION = 'body_v1'
export const NORMALIZATION_VERSION = '1'
export const STORAGE_CHUNK_BYTES = 256 * 1024
/** 真实 CN 关联规则未验证前，单一匹配也只报 unverified。G1 验证后改为 true。 */
export const JOIN_RULES_VERIFIED = false

// 同步响应里已知的非测量容器；其余未知 *_list 视为新数据集，fail-closed 并标 partial。
const NON_MEASUREMENT_KEYS = new Set(['account', 'devices', 'bind_device', 'users', 'products'])

const WEIGHT_METRICS: Record<string, string> = {
  weight_kg: 'weight_kg',
  bmi: 'bmi',
  bfr: 'body_fat_pct',
  rom: 'muscle_pct',
  rosm: 'skeletal_muscle_pct',
  vwc: 'body_water_pct',
  pp: 'protein_pct',
  sfr: 'subcutaneous_fat_pct',
  uvi: 'visceral_fat_index',
  bm: 'bone_mass_kg',
  bmr: 'bmr_kcal',
  bodyage: 'body_age',
  hr: 'heart_rate_bpm',
}
const EXT_METRICS: Record<string, string> = { smi: 'smi', whr: 'whr' }

export interface ManifestEntry {
  presence: 'missing' | 'null' | 'array' | 'unexpected_type'
  count: number
  keys: Record<string, string[]>
}

export interface PreparedRecord {
  dataset: Dataset
  profileRef: string
  sourceRecordId: string
  identityKind: 'source_id' | 'content_hash'
  rawText: string
  rawHash: string
  byteLength: number
  redactedPaths: string[]
  sourceDataId: string | null
  measuredTimeRaw: string | null
  measuredAt: number | null
  localDate: string | null
  isDeleted: 0 | 1 | null
  isDeletedRaw: string | null
  deviceRef: string | null
  impDataId: string | null
  balanceDataId: string | null
  gravityDataId: string | null
  metrics: Record<string, number | null>
  extParseStatus: string
  qualityFlags: string[]
}

export interface PreparedBatch {
  manifests: {
    window: CapturedWindow['window']
    datasets: Record<string, ManifestEntry>
    unknownDatasets: string[]
  }[]
  records: PreparedRecord[]
  blocked: (BlockedItem & { dataset: string; recordIndex: number | null })[]
  profiles: { profile_ref: string; label: string | null }[]
  devices: { device_ref: string; model: string | null; firmware: string | null }[]
  partial: boolean
}

export const scalarText = (value: unknown): string | null => {
  if (isRawNumber(value)) return value.rawJSON
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return String(value)
  return null
}

const NUMERIC = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/

/** 只接受有限且可安全表示的数值；否则返回 null 并标记，raw 仍保留原词法。 */
export function safeNumber(value: unknown, flags: Set<string>, field: string): number | null {
  let text: string | null = null
  if (isRawNumber(value)) text = value.rawJSON
  else if (typeof value === 'number') text = String(value)
  else if (typeof value === 'string' && NUMERIC.test(value.trim())) {
    text = value.trim()
    flags.add(`${field}_numeric_string`)
  }
  if (text === null) return null
  const n = Number(text)
  if (!Number.isFinite(n) || (/^[-+]?\d+$/.test(text) && !Number.isSafeInteger(n))) {
    flags.add('numeric_precision_unverified')
    return null
  }
  return n
}

const refOf = async (kind: 'p' | 'd', value: string) =>
  `${kind}_${(await sha256Hex(`${kind === 'p' ? 'profile' : 'device'}\u0000${value}`)).slice(0, 16)}`

const nonEmptyId = (value: unknown): string | null => {
  const text = scalarText(value)
  return text === null || text === '' || text === '0' ? null : text
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (isRawNumber(value)) return 'number'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

async function prepareRecord(
  dataset: Dataset,
  sanitized: ReturnType<typeof sanitizeRecord>,
): Promise<PreparedRecord> {
  const rec = sanitized.value
  const flags = new Set<string>()
  if (sanitized.redactedPaths.length > 0) flags.add('redacted')
  const rawText = JSON.stringify(rec)
  const suid = nonEmptyId(rec.suid)
  const profileRef = suid ? await refOf('p', suid) : 'p_unknown'
  if (!suid) flags.add('profile_unknown')
  const dataId = nonEmptyId(rec.data_id)
  const sourceRecordId = dataId ?? `sha256:${await sha256Hex(canonicalStringify(rec))}`

  const measuredTimeRaw = scalarText(rec.measured_time)
  let measuredAt = safeNumber(rec.measured_time, flags, 'measured_time')
  if (measuredAt !== null && measuredAt > 1e11) {
    measuredAt = Math.floor(measuredAt / 1000)
    flags.add('measured_time_ms_assumed')
  }
  if (measuredAt !== null) measuredAt = Math.floor(measuredAt)
  if (measuredAt === null) flags.add('measured_time_missing')

  const isDeletedRaw = scalarText(rec.is_deleted)
  let isDeleted: 0 | 1 | null
  if (isDeletedRaw === null) {
    isDeleted = 0
    if (!Object.hasOwn(rec, 'is_deleted')) flags.add('is_deleted_missing')
    else {
      isDeleted = null
      flags.add('is_deleted_unrecognized')
    }
  } else if (isDeletedRaw === '0' || isDeletedRaw === 'false') isDeleted = 0
  else if (isDeletedRaw === '1' || isDeletedRaw === 'true') isDeleted = 1
  else {
    isDeleted = null
    flags.add('is_deleted_unrecognized')
  }

  const deviceId = nonEmptyId(rec.device_id)
  const metrics: Record<string, number | null> = {}
  if (dataset === 'weight') {
    for (const [field, metric] of Object.entries(WEIGHT_METRICS)) {
      if (Object.hasOwn(rec, field)) metrics[metric] = safeNumber(rec[field], flags, field)
    }
    if (metrics.weight_kg === undefined && Object.hasOwn(rec, 'weight_g')) {
      const grams = safeNumber(rec.weight_g, flags, 'weight_g')
      if (grams !== null) {
        metrics.weight_kg = grams / 1000
        flags.add('weight_kg_from_grams')
      }
    }
    const ext = sanitized.extParsed
    if (sanitized.extStatus === 'ok' && ext && typeof ext === 'object' && !Array.isArray(ext)) {
      for (const [field, metric] of Object.entries(EXT_METRICS)) {
        const record = ext as Record<string, unknown>
        if (Object.hasOwn(record, field)) metrics[metric] = safeNumber(record[field], flags, field)
      }
    }
  } else if (dataset === 'height' && Object.hasOwn(rec, 'height_cm')) {
    metrics.height_cm = safeNumber(rec.height_cm, flags, 'height_cm')
  }

  return {
    dataset,
    profileRef,
    sourceRecordId,
    identityKind: dataId ? 'source_id' : 'content_hash',
    rawText,
    rawHash: await sha256Hex(rawText),
    byteLength: byteLength(rawText),
    redactedPaths: sanitized.redactedPaths,
    sourceDataId: dataId,
    measuredTimeRaw,
    measuredAt,
    localDate: measuredAt === null ? null : localDate(measuredAt * 1000, DEFAULT_TIMEZONE),
    isDeleted,
    isDeletedRaw,
    deviceRef: deviceId ? await refOf('d', deviceId) : null,
    impDataId: dataset === 'weight' ? nonEmptyId(rec.imp_data_id) : null,
    balanceDataId: dataset === 'weight' ? nonEmptyId(rec.balance_data_id) : null,
    gravityDataId: dataset === 'weight' ? nonEmptyId(rec.gravity_data_id) : null,
    metrics,
    extParseStatus: dataset === 'weight' ? sanitized.extStatus : 'missing',
    qualityFlags: [...flags].sort(),
  }
}

const safeLabel = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string' || value.trim() === '' || isSuspiciousValue(value)) return null
  return value.trim().slice(0, max)
}

/** 纯函数：不接触数据库。解析失败的窗口整体失败，不做部分猜测。 */
export async function prepareWindows(
  windows: CapturedWindow[],
  knownSecrets: Set<string>,
): Promise<PreparedBatch> {
  const batch: PreparedBatch = {
    manifests: [],
    records: [],
    blocked: [],
    profiles: [],
    devices: [],
    partial: false,
  }
  const profiles = new Map<string, string | null>()
  const devices = new Map<string, { model: string | null; firmware: string | null }>()

  for (const captured of windows) {
    let parsed: unknown
    try {
      parsed = parseLossless(captured.text)
    } catch {
      throw new KtError('INCOMPLETE_SYNC', { category: 'invalid_json' })
    }
    const data = (parsed as { data?: unknown })?.data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new KtError('INCOMPLETE_SYNC', { category: 'data_not_object' })
    }
    const body = data as Record<string, unknown>
    // account 整体丢弃，但先把其中的认证值加入精确匹配集合。
    collectSecretValues(body.account, knownSecrets, true)

    const manifest: Record<string, ManifestEntry> = {}
    for (const dataset of DATASETS) {
      const key = `${dataset}_list`
      const list = body[key]
      if (!Object.hasOwn(body, key)) {
        manifest[dataset] = { presence: 'missing', count: 0, keys: {} }
        continue
      }
      if (list === null) {
        manifest[dataset] = { presence: 'null', count: 0, keys: {} }
        continue
      }
      if (!Array.isArray(list)) {
        manifest[dataset] = { presence: 'unexpected_type', count: 0, keys: {} }
        batch.partial = true
        continue
      }
      const keys: Record<string, Set<string>> = {}
      for (const item of list) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        for (const [k, v] of Object.entries(item)) {
          const name = isSuspiciousValue(k, knownSecrets) ? '<redacted-key>' : k
          keys[name] = (keys[name] ?? new Set()).add(typeName(v))
        }
      }
      manifest[dataset] = {
        presence: 'array',
        count: list.length,
        keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, [...v].sort()])),
      }
      for (let index = 0; index < list.length; index++) {
        const sanitized = sanitizeRecord(list[index], dataset, knownSecrets)
        if (sanitized.blocked.length > 0) {
          batch.partial = true
          for (const item of sanitized.blocked) batch.blocked.push({ ...item, dataset, recordIndex: index })
          continue
        }
        const prepared = await prepareRecord(dataset, sanitized)
        batch.records.push(prepared)
        const suid = nonEmptyId(sanitized.value.suid)
        if (suid && !profiles.has(prepared.profileRef)) profiles.set(prepared.profileRef, null)
      }
    }
    const unknownDatasets = Object.keys(body).filter(
      (k) => !NON_MEASUREMENT_KEYS.has(k) && !DATASETS.some((d) => `${d}_list` === k),
    )
    if (unknownDatasets.length > 0) batch.partial = true
    batch.manifests.push({ window: captured.window, datasets: manifest, unknownDatasets })

    if (Array.isArray(body.users)) {
      for (const user of body.users) {
        if (!user || typeof user !== 'object') continue
        const u = user as Record<string, unknown>
        const suid = nonEmptyId(u.suid)
        if (suid) profiles.set(await refOf('p', suid), safeLabel(u.nickname, 80))
      }
    }
    for (const list of [body.devices, body.bind_device]) {
      if (!Array.isArray(list)) continue
      for (const device of list) {
        if (!device || typeof device !== 'object') continue
        const d = device as Record<string, unknown>
        const id = nonEmptyId(d.device_id)
        if (!id) continue
        const ref = await refOf('d', id)
        const prior = devices.get(ref)
        devices.set(ref, {
          model: safeLabel(d.model, 120) ?? prior?.model ?? null,
          firmware: safeLabel(d.firmware_ver, 120) ?? prior?.firmware ?? null,
        })
      }
    }
  }
  for (const record of batch.records) {
    if (record.deviceRef && !devices.has(record.deviceRef))
      devices.set(record.deviceRef, { model: null, firmware: null })
  }
  batch.profiles = [...profiles].map(([profile_ref, label]) => ({ profile_ref, label }))
  batch.devices = [...devices].map(([device_ref, v]) => ({ device_ref, ...v }))
  return batch
}

// ───────────── 暂存与发布 ─────────────

const JSON_PARAM_BUDGET = 900_000

function packJson(rows: unknown[]): string[] {
  const packs: string[] = []
  let current: string[] = []
  let size = 2
  for (const row of rows) {
    const text = JSON.stringify(row)
    if (current.length > 0 && size + text.length + 1 > JSON_PARAM_BUDGET) {
      packs.push(`[${current.join(',')}]`)
      current = []
      size = 2
    }
    current.push(text)
    size += text.length + 1
  }
  if (current.length > 0) packs.push(`[${current.join(',')}]`)
  return packs
}

const col = (name: string) => `json_extract(j.value, '$.${name}')`

export interface StageResult {
  versionCount: number
  unchangedRecordIds: string[]
  touchedRecordIds: string[]
}

export async function stageBatch(
  db: D1Database,
  ownerId: string,
  batchId: string,
  generation: number,
  prepared: PreparedBatch,
  nowMs: number,
): Promise<StageResult> {
  const existing = new Map<string, { id: string; latestHash: string | null }>()
  const rows = await db
    .prepare(
      `SELECT r.id, r.dataset, r.profile_ref, r.source_record_id,
        (SELECT v.raw_hash FROM raw_record_versions v WHERE v.raw_record_id = r.id AND v.published = 1
         ORDER BY v.generation DESC, v.stage_index DESC LIMIT 1) AS latest_hash
       FROM raw_records r WHERE r.owner_id = ?`,
    )
    .bind(ownerId)
    .all<{
      id: string
      dataset: string
      profile_ref: string
      source_record_id: string
      latest_hash: string | null
    }>()
  for (const row of rows.results) {
    existing.set(`${row.dataset}\u0000${row.profile_ref}\u0000${row.source_record_id}`, {
      id: row.id,
      latestHash: row.latest_hash,
    })
  }

  const newRecords: unknown[] = []
  const versions: unknown[] = []
  const chunks: { versionId: string; index: number; bytes: Uint8Array; hash: string }[] = []
  const unchanged = new Set<string>()
  const touched = new Set<string>()
  const stagedHashes = new Map<string, string>()

  for (const [stageIndex, record] of prepared.records.entries()) {
    const key = `${record.dataset}\u0000${record.profileRef}\u0000${record.sourceRecordId}`
    let identity = existing.get(key)
    const flags = [...record.qualityFlags]
    if (!identity) {
      identity = { id: crypto.randomUUID(), latestHash: null }
      existing.set(key, identity)
      newRecords.push({
        id: identity.id,
        dataset: record.dataset,
        profile_ref: record.profileRef,
        source_record_id: record.sourceRecordId,
        identity_kind: record.identityKind,
      })
    }
    const stagedHash = stagedHashes.get(key)
    if (stagedHash === record.rawHash) continue // 重叠窗口里的同一条记录
    if (stagedHash !== undefined) flags.push('duplicate_in_batch_differs')
    else if (identity.latestHash === record.rawHash) {
      unchanged.add(identity.id)
      stagedHashes.set(key, record.rawHash)
      continue
    }
    stagedHashes.set(key, record.rawHash)
    unchanged.delete(identity.id)
    touched.add(identity.id)

    const versionId = crypto.randomUUID()
    const inline = record.byteLength <= STORAGE_CHUNK_BYTES
    let chunkCount = 0
    if (!inline) {
      const bytes = encoder.encode(record.rawText)
      for (let offset = 0; offset < bytes.length; offset += STORAGE_CHUNK_BYTES) {
        const part = bytes.slice(offset, offset + STORAGE_CHUNK_BYTES)
        chunks.push({ versionId, index: chunkCount++, bytes: part, hash: await sha256Hex(part) })
      }
    }
    versions.push({
      id: versionId,
      raw_record_id: identity.id,
      dataset: record.dataset,
      profile_ref: record.profileRef,
      stage_index: stageIndex,
      raw_hash: record.rawHash,
      byte_length: record.byteLength,
      raw_json: inline ? record.rawText : null,
      chunk_count: chunkCount,
      redacted_paths_json: JSON.stringify(record.redactedPaths),
      source_data_id: record.sourceDataId,
      measured_time_raw: record.measuredTimeRaw,
      measured_at: record.measuredAt,
      local_date: record.localDate,
      is_deleted: record.isDeleted,
      is_deleted_raw: record.isDeletedRaw,
      device_ref: record.deviceRef,
      imp_data_id: record.impDataId,
      balance_data_id: record.balanceDataId,
      gravity_data_id: record.gravityDataId,
      metrics_json: JSON.stringify(record.metrics),
      ext_parse_status: record.extParseStatus,
      quality_flags_json: JSON.stringify([...new Set(flags)].sort()),
    })
  }

  const statements: D1PreparedStatement[] = []
  for (const pack of packJson(newRecords)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO raw_records (id, owner_id, dataset, profile_ref, source_record_id, identity_kind, first_seen_at, last_seen_at)
           SELECT ${col('id')}, ?1, ${col('dataset')}, ${col('profile_ref')}, ${col('source_record_id')}, ${col('identity_kind')}, ?2, ?2
           FROM json_each(?3) AS j`,
        )
        .bind(ownerId, nowMs, pack),
    )
  }
  const versionColumns = [
    'id',
    'raw_record_id',
    'dataset',
    'profile_ref',
    'stage_index',
    'raw_hash',
    'byte_length',
    'raw_json',
    'chunk_count',
    'redacted_paths_json',
    'source_data_id',
    'measured_time_raw',
    'measured_at',
    'local_date',
    'is_deleted',
    'is_deleted_raw',
    'device_ref',
    'imp_data_id',
    'balance_data_id',
    'gravity_data_id',
    'metrics_json',
    'ext_parse_status',
    'quality_flags_json',
  ]
  for (const pack of packJson(versions)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO raw_record_versions (${versionColumns.join(', ')}, owner_id, batch_id, generation, published,
             raw_format_version, sanitizer_version, formula_version, normalization_version, created_at)
           SELECT ${versionColumns.map(col).join(', ')}, ?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8
           FROM json_each(?9) AS j`,
        )
        .bind(
          ownerId,
          batchId,
          generation,
          RAW_FORMAT_VERSION,
          SANITIZER_VERSION,
          FORMULA_VERSION,
          NORMALIZATION_VERSION,
          nowMs,
          pack,
        ),
    )
  }
  for (const chunk of chunks) {
    statements.push(
      db
        .prepare('INSERT INTO raw_chunks (version_id, chunk_index, data, chunk_hash) VALUES (?, ?, ?, ?)')
        .bind(chunk.versionId, chunk.index, chunk.bytes, chunk.hash),
    )
  }
  const blockedRows = prepared.blocked.map((b) => ({
    dataset: b.dataset,
    record_index: b.recordIndex,
    path: b.path,
    value_type: b.valueType,
    code: b.code,
  }))
  for (const pack of packJson(blockedRows)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO blocked_items (batch_id, owner_id, dataset, record_index, path, value_type, code)
           SELECT ?1, ?2, ${col('dataset')}, ${col('record_index')}, ${col('path')}, ${col('value_type')}, ${col('code')}
           FROM json_each(?3) AS j`,
        )
        .bind(batchId, ownerId, pack),
    )
  }
  // 暂存可以分多个 batch：未发布版本对查询不可见，失败后由清理逻辑移除。
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50))

  return {
    versionCount: versions.length,
    unchangedRecordIds: [...unchanged],
    touchedRecordIds: [...touched],
  }
}

export interface PublishInput {
  ownerId: string
  batchId: string
  generation: number
  state: 'published' | 'partial'
  mode: 'initial_full' | 'incremental' | 'reconciliation_full'
  checkpointNewest: number | null
  seenRecordIds: string[]
  prepared: PreparedBatch
  nowMs: number
}

/** 单个 D1 batch 原子发布；lease 已被新任务接管（fencing generation 不符）时整体回滚。 */
export async function publishBatch(db: D1Database, input: PublishInput): Promise<void> {
  const { ownerId, batchId, generation, nowMs } = input
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO guard (ok) SELECT NULL WHERE NOT EXISTS
         (SELECT 1 FROM sync_lease WHERE owner_id = ? AND generation = ? AND holder = ?)`,
      )
      .bind(ownerId, generation, batchId),
    db
      .prepare('UPDATE raw_record_versions SET published = 1 WHERE batch_id = ? AND published = 0')
      .bind(batchId),
  ]
  for (const pack of packJson(input.seenRecordIds)) {
    statements.push(
      db
        .prepare(
          'UPDATE raw_records SET last_seen_at = ? WHERE owner_id = ? AND id IN (SELECT value FROM json_each(?))',
        )
        .bind(nowMs, ownerId, pack),
    )
  }
  for (const pack of packJson(input.prepared.profiles)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO profiles (owner_id, profile_ref, label, updated_at)
           SELECT ?1, ${col('profile_ref')}, ${col('label')}, ?2 FROM json_each(?3) AS j WHERE true
           ON CONFLICT (owner_id, profile_ref) DO UPDATE SET label = COALESCE(excluded.label, profiles.label),
             updated_at = excluded.updated_at`,
        )
        .bind(ownerId, nowMs, pack),
    )
  }
  for (const pack of packJson(input.prepared.devices)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO devices (owner_id, device_ref, model, firmware, updated_at)
           SELECT ?1, ${col('device_ref')}, ${col('model')}, ${col('firmware')}, ?2 FROM json_each(?3) AS j WHERE true
           ON CONFLICT (owner_id, device_ref) DO UPDATE SET model = COALESCE(excluded.model, devices.model),
             firmware = COALESCE(excluded.firmware, devices.firmware), updated_at = excluded.updated_at`,
        )
        .bind(ownerId, nowMs, pack),
    )
  }
  const full = input.mode !== 'incremental'
  statements.push(
    db
      .prepare(
        `INSERT INTO sync_meta (owner_id, published_generation, last_published_at, last_published_batch_id,
           last_published_state, last_attempt_at, last_error_code, checkpoint_newest, last_full_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?3, NULL, ?6, CASE WHEN ?7 THEN ?3 ELSE NULL END)
         ON CONFLICT (owner_id) DO UPDATE SET published_generation = ?2, last_published_at = ?3,
           last_published_batch_id = ?4, last_published_state = ?5, last_attempt_at = ?3, last_error_code = NULL,
           checkpoint_newest = COALESCE(?6, sync_meta.checkpoint_newest),
           last_full_at = CASE WHEN ?7 THEN ?3 ELSE sync_meta.last_full_at END`,
      )
      .bind(ownerId, generation, nowMs, batchId, input.state, input.checkpointNewest, full ? 1 : 0),
    db
      .prepare('UPDATE sync_batches SET state = ?, finished_at = ? WHERE id = ?')
      .bind(input.state, nowMs, batchId),
    db
      .prepare('UPDATE sync_lease SET holder = NULL, expires_at = 0 WHERE owner_id = ? AND generation = ?')
      .bind(ownerId, generation),
  )
  await db.batch(statements)
}

/** 失败批次：标记失败、移除未发布暂存（已发布数据不受影响）、释放自己的 lease。 */
export async function failBatch(
  db: D1Database,
  ownerId: string,
  batchId: string,
  generation: number | null,
  code: string,
  nowMs: number,
): Promise<void> {
  const statements = [
    db
      .prepare(
        'DELETE FROM raw_chunks WHERE version_id IN (SELECT id FROM raw_record_versions WHERE batch_id = ? AND published = 0)',
      )
      .bind(batchId),
    db.prepare('DELETE FROM raw_record_versions WHERE batch_id = ? AND published = 0').bind(batchId),
    db
      .prepare("UPDATE sync_batches SET state = 'failed', error_code = ?, finished_at = ? WHERE id = ?")
      .bind(code, nowMs, batchId),
    db
      .prepare(
        `INSERT INTO sync_meta (owner_id, last_attempt_at, last_error_code) VALUES (?1, ?2, ?3)
         ON CONFLICT (owner_id) DO UPDATE SET last_attempt_at = ?2, last_error_code = ?3`,
      )
      .bind(ownerId, nowMs, code),
  ]
  if (generation !== null) {
    statements.push(
      db
        .prepare(
          'UPDATE sync_lease SET holder = NULL, expires_at = 0 WHERE owner_id = ? AND generation = ? AND holder = ?',
        )
        .bind(ownerId, generation, batchId),
    )
  }
  await db.batch(statements)
}
