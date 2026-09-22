// 体脂秤网关推送入口（DATA_CONTRACT 第 10 节）：限流 → 网关令牌 → 有界读取 → 严格校验 →
// 在 sync_lease 内查墓碑与已存 → 按本人体重窗口筛 → 暂存 → 原子发布（复用 measurements.ts）。
// 体重与阻抗由服务端从 A7 帧自己解；体成分是网关按 WLA37 算的估算值，这里只校验一致性与范围。
// 请求体里没有自由字符串；响应只含计数与稳定错误码；日志只经 logEvent。

import { Validator } from '@cfworker/json-schema'
import { profileMatches } from './ingest'
import type { Deps } from './mcp'
import { failBatch, type PreparedRecord, publishBatch, stageBatch } from './measurements'
import { deletedSources } from './purge'
import { readSnapshot, VISIBLE } from './queries'
import { consumeRateLimit } from './ratelimit'
import { findSecretPath } from './sanitize'
import { acquireLease } from './sync'
import {
  byteLength,
  canonicalStringify,
  constantTimeEqual,
  DEFAULT_TIMEZONE,
  KtError,
  localDate,
  logEvent,
  parseInstant,
  readBodyLimited,
  sha256Hex,
} from './util'

export const SCALE_PATH = '/ingest/scale'
const MAX_BODY_BYTES = 64 * 1024
const MAX_ITEMS = 50
const FUTURE_SKEW_MS = 5 * 60_000
const RATE_LIMIT_PER_IP_PER_MINUTE = 30
const RATE_LIMIT_GLOBAL_PER_MINUTE = 60
/** 只存本人：新称重和本人近 14 天已发布体重的中位数比；这段时间没有就和最近一条比。 */
const REFERENCE_DAYS = 14
/** A7 载荷 [5] 是 WLA 编号，沃莱 P3 是 37（research/P3.md 第 4 节）。 */
const P3_ALGORITHM = 37

// 取值范围 (下限, 上限]；越界的指标不进索引（raw 照存）并打标，不连累同次称重。body_score 只在 raw。
const RANGES: Record<string, [number, number]> = {
  bmi: [5, 100],
  body_fat_pct: [0, 100],
  muscle_pct: [0, 100],
  subcutaneous_fat_pct: [0, 100],
  visceral_fat_index: [0, 100],
  bone_mass_kg: [0, 400],
  body_water_pct: [0, 100],
  protein_pct: [0, 100],
  skeletal_muscle_pct: [0, 100],
  bmr_kcal: [300, 5000],
  body_age: [0, 150],
  body_score: [0, 200],
}
const RAW_ONLY = new Set(['body_score'])

const validator = new Validator(
  {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'measurements'],
    properties: {
      schema_version: { const: '1' },
      measurements: {
        type: 'array',
        maxItems: MAX_ITEMS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['time_ms', 'a7_hex', 'algorithm', 'inputs', 'metrics'],
          properties: {
            time_ms: { type: 'integer', minimum: 0, maximum: 1e14 },
            // A7 载荷原样：11 字节头 + 阻抗 + 几个用途未知的尾字节，共 11–60 字节
            a7_hex: { type: 'string', pattern: '^a7(?:[0-9a-f]{2}){10,59}$' },
            algorithm: { const: 'WLA37' },
            inputs: {
              type: 'object',
              additionalProperties: false,
              required: ['height_cm', 'age', 'sex', 'people_type'],
              properties: {
                height_cm: { type: 'integer', minimum: 100, maximum: 260 },
                age: { type: 'integer', minimum: 0, maximum: 150 },
                sex: { enum: [0, 1] },
                people_type: { enum: [0, 1] },
              },
            },
            metrics: {
              type: 'object',
              additionalProperties: false,
              required: ['bmi'],
              properties: Object.fromEntries(Object.keys(RANGES).map((k) => [k, { type: 'number' }])),
            },
          },
        },
      },
    },
  },
  '2020-12',
  false,
)

interface ScaleItem {
  time_ms: number
  a7_hex: string
  algorithm: 'WLA37'
  inputs: { height_cm: number; age: number; sex: 0 | 1; people_type: 0 | 1 }
  metrics: Record<string, number>
}

export interface ScalePayload {
  schema_version: '1'
  measurements: ScaleItem[]
}

export interface ScaleResult {
  accepted: number
  unchanged: number
  rejected: { time_ms: number; code: string }[]
}

export interface A7 {
  weightKg: number
  impedancesOhm: number[]
  algorithm: number
}

/** A7 载荷：[5] 算法号、[6:9] 体重 u24BE 克、[10] 阻抗个数、[11:] 个数 × u16BE ÷ 10 欧姆，之后几个尾字节用途未知。 */
export function decodeA7(hex: string): A7 | null {
  const b = Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16))
  const at = (i: number) => b[i] ?? 0
  if (b.length < 11 || at(0) !== 0xa7) return null
  const n = at(10)
  // 真机阻抗后面跟 4 个尾字节；长度对不上或多出 8 个以上当作帧读错，不猜。
  if (b.length < 11 + 2 * n || b.length > 11 + 2 * n + 8) return null
  return {
    weightKg: ((at(6) << 16) | (at(7) << 8) | at(8)) / 1000,
    impedancesOhm: Array.from({ length: n }, (_, i) => ((at(11 + 2 * i) << 8) | at(12 + 2 * i)) / 10),
    algorithm: at(5),
  }
}

/** 同一帧就是同一次称重：秤下次连接时可能重发缓存的旧结果，按接收时间做身份会重复入库、也绕过墓碑。 */
const keyOf = async (a7Hex: string) => `ble:p3:${(await sha256Hex(a7Hex)).slice(0, 32)}`

/** 单条校验：返回拒绝码，通过返回 null。 */
function itemProblem(item: ScaleItem, frame: A7 | null, acceptAfterMs: number, nowMs: number): string | null {
  if (!frame) return 'SCALE_FRAME_INVALID'
  if (!(frame.weightKg > 2 && frame.weightKg <= 400)) return 'SCALE_VALUE_OUT_OF_RANGE'
  if (item.time_ms <= acceptAfterMs) return 'SCALE_BEFORE_CUTOVER'
  if (item.time_ms > nowMs + FUTURE_SKEW_MS) return 'SCALE_FUTURE_TIME'
  // 体成分只能来自 P3 的算法和 10 个阻抗；BMI 必须是这帧体重按网关声明的身高算出来的（WLA37 一位小数、半入）。
  const body = Object.keys(item.metrics).some((k) => k !== 'bmi')
  if (body && (frame.algorithm !== P3_ALGORITHM || frame.impedancesOhm.length !== 10)) {
    return 'SCALE_METRICS_INCONSISTENT'
  }
  const bmi = (frame.weightKg * 10_000) / item.inputs.height_cm ** 2
  if (Math.abs((item.metrics.bmi ?? Number.NaN) - bmi) > 0.06) return 'SCALE_METRICS_INCONSISTENT'
  return null
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

/** 本人已发布、有效的体重（新到旧），用来判断新称重是不是本人。 */
async function ownerWeights(
  db: D1Database,
  ownerId: string,
  profileRef: string,
  beforeSec: number,
  nowMs: number,
) {
  const { generation } = await readSnapshot(db, ownerId, nowMs)
  const rows = await db
    .prepare(
      `SELECT v.measured_at AS t, json_extract(v.metrics_json, '$.weight_kg') AS w FROM raw_record_versions v
       WHERE ${VISIBLE} AND v.owner_id = ?2 AND v.dataset = 'weight' AND v.profile_ref = ?3 AND v.is_deleted = 0
         AND v.measured_at IS NOT NULL AND v.measured_at < ?4 AND json_extract(v.metrics_json, '$.weight_kg') IS NOT NULL
       ORDER BY v.measured_at DESC LIMIT 500`,
    )
    .bind(generation, ownerId, profileRef, beforeSec)
    .all<{ t: number; w: number }>()
  return rows.results
}

function referenceWeight(weights: { t: number; w: number }[], timeMs: number): number | null {
  const sec = timeMs / 1000
  const earlier = weights.filter((r) => r.t < sec)
  const recent = earlier.filter((r) => r.t >= sec - REFERENCE_DAYS * 86_400).map((r) => r.w)
  if (recent.length > 0) return median(recent)
  return earlier[0]?.w ?? null
}

async function prepare(item: ScaleItem, frame: A7, key: string, profileRef: string): Promise<PreparedRecord> {
  const rawText = canonicalStringify({
    source: 'ble',
    device: 'p3',
    time_ms: item.time_ms,
    a7_hex: item.a7_hex,
    weight_kg: frame.weightKg,
    impedances_ohm: frame.impedancesOhm,
    algorithm: item.algorithm,
    inputs: item.inputs,
    metrics: item.metrics,
  })
  const flags = new Set(['source_ble_p3'])
  flags.add(Object.keys(item.metrics).some((k) => k !== 'bmi') ? 'wla37_computed_by_gateway' : 'weight_only')
  const metrics: Record<string, number | null> = { weight_kg: frame.weightKg }
  for (const [name, value] of Object.entries(item.metrics)) {
    if (RAW_ONLY.has(name)) continue
    const [low, high] = RANGES[name] as [number, number]
    if (value > low && value <= high) metrics[name] = value
    else {
      metrics[name] = null
      flags.add(`${name}_out_of_range`)
    }
  }
  const measuredAt = Math.floor(item.time_ms / 1000)
  return {
    dataset: 'weight',
    profileRef,
    sourceRecordId: key,
    identityKind: 'content_hash',
    rawText,
    rawHash: await sha256Hex(rawText),
    byteLength: byteLength(rawText),
    redactedPaths: [],
    sourceDataId: null,
    measuredTimeRaw: String(measuredAt),
    measuredAt,
    localDate: localDate(measuredAt * 1000, DEFAULT_TIMEZONE),
    isDeleted: 0,
    isDeletedRaw: null,
    deviceRef: null,
    impDataId: null,
    balanceDataId: null,
    gravityDataId: null,
    metrics,
    extParseStatus: 'missing',
    qualityFlags: [...flags].sort(),
  }
}

export async function ingestScale(
  env: Env,
  ownerId: string,
  profileRef: string,
  acceptAfterMs: number,
  windowKg: number,
  payload: ScalePayload,
  deps: Deps,
): Promise<ScaleResult | 'busy' | 'profile_mismatch'> {
  const nowMs = deps.now()
  const result: ScaleResult = { accepted: 0, unchanged: 0, rejected: [] }
  const incoming = new Map<string, { item: ScaleItem; frame: A7 }>()
  for (const item of payload.measurements) {
    const frame = decodeA7(item.a7_hex)
    const key = await keyOf(item.a7_hex)
    const problem =
      itemProblem(item, frame, acceptAfterMs, nowMs) ?? (incoming.has(key) ? 'SCALE_DUPLICATE' : null)
    if (problem || !frame)
      result.rejected.push({ time_ms: item.time_ms, code: problem ?? 'SCALE_FRAME_INVALID' })
    else incoming.set(key, { item, frame })
  }
  if (incoming.size === 0) return result

  const db = env.DB
  if (!(await profileMatches(db, ownerId, profileRef))) return 'profile_mismatch'
  const batchId = crypto.randomUUID()
  const generation = await acquireLease(db, ownerId, batchId, nowMs)
  if (generation === null) return 'busy'
  await db
    .prepare(
      `INSERT INTO sync_batches (id, owner_id, mode, state, generation, source_region, attempts, created_at, started_at)
       VALUES (?1, ?2, 'incremental', 'staging', ?3, 'ble', 1, ?4, ?4)`,
    )
    .bind(batchId, ownerId, generation, nowMs)
    .run()

  try {
    // 在 lease 内读：删除与其他推送都要拿同一个 lease，查完之后状态不会变。
    const keys = [...incoming.keys()]
    const deleted = await deletedSources(db, ownerId, 'weight', profileRef, keys)
    const stored = await db
      .prepare(
        `SELECT r.source_record_id AS key FROM raw_records r
         WHERE r.owner_id = ?1 AND r.dataset = 'weight' AND r.profile_ref = ?2
           AND r.source_record_id IN (SELECT value FROM json_each(?3))
           AND EXISTS (SELECT 1 FROM raw_record_versions v WHERE v.raw_record_id = r.id AND v.published = 1)`,
      )
      .bind(ownerId, profileRef, JSON.stringify(keys))
      .all<{ key: string }>()
    const existing = new Set(stored.results.map((r) => r.key))
    const latest = Math.max(...[...incoming.values()].map(({ item }) => item.time_ms))
    const weights = await ownerWeights(db, ownerId, profileRef, Math.ceil(latest / 1000), nowMs)

    const records: PreparedRecord[] = []
    for (const [key, { item, frame }] of incoming) {
      if (deleted.has(key)) {
        result.rejected.push({ time_ms: item.time_ms, code: 'MEASUREMENT_DELETED' })
        continue
      }
      // 已入库的帧不再改：重发的旧结果保留第一次收到的时刻。
      if (existing.has(key)) {
        result.unchanged++
        continue
      }
      const reference = referenceWeight(weights, item.time_ms)
      if (reference === null) {
        result.rejected.push({ time_ms: item.time_ms, code: 'SCALE_NO_REFERENCE' })
        continue
      }
      if (Math.abs(frame.weightKg - reference) > windowKg) {
        result.rejected.push({ time_ms: item.time_ms, code: 'SCALE_WEIGHT_OUT_OF_WINDOW' })
        continue
      }
      records.push(await prepare(item, frame, key, profileRef))
    }

    const prepared = {
      manifests: [],
      records,
      blocked: [],
      profiles: [{ profile_ref: profileRef, label: null }],
      devices: [],
      partial: false,
      excluded: 0,
    }
    const staged = await stageBatch(db, ownerId, batchId, generation, prepared, nowMs)
    result.accepted = staged.versionCount
    result.unchanged += records.length - staged.versionCount
    await db
      .prepare('UPDATE sync_batches SET counts_json = ? WHERE id = ?')
      .bind(JSON.stringify({ weight: staged.versionCount, rejected: result.rejected.length }), batchId)
      .run()
    await publishBatch(db, {
      ownerId,
      batchId,
      generation,
      state: 'published',
      mode: 'incremental',
      checkpointNewest: null,
      seenRecordIds: [...staged.unchangedRecordIds, ...staged.touchedRecordIds],
      prepared,
      nowMs: deps.now(),
    })
    return result
  } catch (error) {
    await failBatch(
      db,
      ownerId,
      batchId,
      generation,
      error instanceof KtError ? error.code : 'STORAGE_FAILED',
      deps.now(),
    )
    throw error
  }
}

/** SCALE_ACCEPT_AFTER：网关来源的起点，也是 Health Connect 来源的终点（两个来源不同时导入同一时段）。 */
export function scaleCutover(env: Env): number | null | 'invalid' {
  const text = env.SCALE_ACCEPT_AFTER ?? ''
  if (text === '') return null
  return parseInstant(text) ?? 'invalid'
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })

export async function handleScale(request: Request, env: Env, deps: Deps): Promise<Response> {
  const expected = env.SCALE_INGEST_TOKEN_SHA256?.trim().toLowerCase()
  // 未配置令牌或方法不对时与不存在的路径表现一致。
  if (request.method !== 'POST' || !expected) return new Response('Not found', { status: 404 })
  const started = deps.now()
  try {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    await consumeRateLimit(env.DB, `scale:${ip}`, RATE_LIMIT_PER_IP_PER_MINUTE, 60, started)

    const header = request.headers.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!token || !constantTimeEqual(await sha256Hex(token), expected)) {
      logEvent({ event: 'scale', status: 'unauthorized' })
      return reply(401, { error: 'unauthorized' })
    }
    await consumeRateLimit(env.DB, 'scale:all', RATE_LIMIT_GLOBAL_PER_MINUTE, 60, started)
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return reply(415, { error: 'unsupported_media_type' })
    }
    const bytes = await readBodyLimited(request.body, MAX_BODY_BYTES)
    if (!bytes) return reply(413, { error: 'payload_too_large' })
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
    } catch {
      return reply(400, { error: 'invalid_json' })
    }
    if (!validator.validate(payload).valid || findSecretPath(payload)) {
      return reply(400, { error: 'invalid_payload' })
    }
    const cutover = scaleCutover(env)
    const windowKg = Number(env.SCALE_WEIGHT_WINDOW_KG)
    if (typeof cutover !== 'number' || !env.HC_PROFILE_REF || !(windowKg > 0 && windowKg <= 50)) {
      return reply(503, { error: 'not_configured' })
    }

    const result = await ingestScale(
      env,
      env.OWNER_ID,
      env.HC_PROFILE_REF,
      cutover,
      windowKg,
      payload as ScalePayload,
      deps,
    )
    if (result === 'busy' || result === 'profile_mismatch') {
      logEvent({ event: 'scale', status: result })
      return result === 'busy'
        ? reply(503, { error: 'busy' }, { 'retry-after': '10' })
        : reply(503, { error: 'not_configured' })
    }
    logEvent({
      event: 'scale',
      status: result.rejected.length > 0 ? 'partial' : 'ok',
      count: result.accepted,
      duration_ms: deps.now() - started,
    })
    return reply(200, result)
  } catch (error) {
    if (error instanceof KtError && error.code === 'RATE_LIMITED') {
      return reply(
        429,
        { error: 'rate_limited' },
        { 'retry-after': String(error.options.retryAfterSeconds ?? 60) },
      )
    }
    logEvent({
      event: 'scale',
      status: 'failed',
      code: error instanceof KtError ? error.code : 'STORAGE_FAILED',
      category: error instanceof Error ? error.name : 'unknown',
    })
    return reply(500, { error: 'storage_failed' })
  }
}
