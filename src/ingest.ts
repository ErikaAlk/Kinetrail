// Health Connect 推送入口（research/HEALTHCONNECT.md 第 3 节）：限流 → 设备令牌 → 有界读取 → 严格校验 →
// 与已存的组合并（已存记录的值不可变，已删类型不能补回，只有明确的 hc_id 删除才会移出）→ 复用暂存/原子发布与 lease。
// 请求体里没有自由字符串；响应只含计数与稳定错误码；日志只经 logEvent。

import { Validator } from '@cfworker/json-schema'
import type { Deps } from './mcp'
import { failBatch, type PreparedRecord, publishBatch, stageBatch } from './measurements'
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

export const INGEST_PATH = '/ingest/health-connect'
export const HC_ORIGIN = 'cn.icomon.fitdayspro'
const MAX_BODY_BYTES = 64 * 1024
const FUTURE_SKEW_MS = 5 * 60_000
const RATE_LIMIT_PER_IP_PER_MINUTE = 30
// 全局上限：令牌泄漏时换 IP 也不能无限写入。正常使用每次打开 App 只有一两个请求。
const RATE_LIMIT_GLOBAL_PER_MINUTE = 60

// 取值范围为 (下限, 上限]；单位由设备端用 HC 单位 API 换算：kg、%、kcal/day、bpm。
// 体重越界整组拒绝；其他类型越界只让该指标不进索引（raw 照存），不连累同次称重。
const RANGES = {
  weight: [2, 400],
  body_fat: [0, 100],
  body_water_mass: [0, 400],
  bone_mass: [0, 400],
  basal_metabolic_rate: [300, 5000],
  lean_body_mass: [0, 400],
  heart_rate: [25, 250],
} as const
type HcType = keyof typeof RANGES
const inRange = (type: HcType, value: number) => value > RANGES[type][0] && value <= RANGES[type][1]

const UUID = {
  type: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
} as const

// 识图报告（FitDays+ 人体成分分析报告图片，手机端 OCR 后只发数字）。字段语义见 DATA_CONTRACT 第 8 节。
const num = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum }) as const
const obj = (properties: Record<string, object>, required: string[] = []) =>
  ({ type: 'object', additionalProperties: false, required, properties }) as const
const MASS = num(0, 400)
const PCT = num(0, 100)
const measured = (value: object) => obj({ value, min: MASS, max: MASS }, ['value'])
const SEGMENTS = ['left_arm', 'right_arm', 'trunk', 'left_leg', 'right_leg'] as const
const segments = (item: object) => obj(Object.fromEntries(SEGMENTS.map((s) => [s, item])), [...SEGMENTS])
const REPORT_SCHEMA = obj(
  {
    // 报告只显示到分钟：FitDays+ 用设备时区把同一个 measure_time 格式化成 yyyy/MM/dd HH:mm（截断）。
    measured_minute_ms: { type: 'integer', minimum: 0, maximum: 1e14, multipleOf: 60_000 },
    height_cm: num(50, 250),
    age: { type: 'integer', minimum: 0, maximum: 150 },
    body_score: num(0, 200),
    weight_kg: measured(num(2, 400)),
    body_fat_kg: measured(MASS),
    bone_mass_kg: measured(MASS),
    protein_kg: measured(MASS),
    body_water_kg: measured(MASS),
    muscle_kg: measured(MASS),
    skeletal_muscle_kg: measured(MASS),
    body_fat_pct: PCT,
    bone_mass_pct: PCT,
    protein_pct: PCT,
    body_water_pct: PCT,
    muscle_pct: PCT,
    skeletal_muscle_pct: PCT,
    bmi: num(5, 100),
    obesity_degree_pct: num(0, 1000),
    target_weight_kg: MASS,
    weight_control_kg: num(-400, 400),
    fat_control_kg: num(-400, 400),
    muscle_control_kg: num(-400, 400),
    visceral_fat_level: num(0, 100),
    bmr_kcal: num(0, 10_000),
    fat_free_mass_kg: MASS,
    subcutaneous_fat_pct: PCT,
    smi: num(0, 100),
    body_age: num(0, 150),
    whr: num(0, 10),
    segment_fat: segments(obj({ kg: MASS, pct: num(0, 1000) }, ['kg', 'pct'])),
    segment_muscle: segments(obj({ kg: MASS, pct: num(0, 1000) }, ['kg', 'pct'])),
    // 报告里的阻抗是 FitDays+ 的显示值（部分分段按 0.826 换算、重排过），不是秤的原始 imps。
    impedance_ohm: obj({
      khz_5: segments(num(0, 100_000)),
      khz_20: segments(num(0, 100_000)),
      khz_100: segments(num(0, 100_000)),
    }),
  },
  ['measured_minute_ms', 'weight_kg'],
)
const MAX_REPORTS = 10

const validator = new Validator(
  {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'groups', 'deleted_hc_ids'],
    properties: {
      schema_version: { const: '1' },
      groups: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['origin', 'time_ms', 'zone_offset_seconds', 'records'],
          properties: {
            origin: { const: HC_ORIGIN },
            time_ms: { type: 'integer', minimum: 0, maximum: 1e14 },
            zone_offset_seconds: { type: ['integer', 'null'], minimum: -64800, maximum: 64800 },
            records: {
              type: 'array',
              minItems: 1,
              // 7 个类型；留出余量让“同类型重复”走逐组拒绝，而不是让整个请求 400、设备卡住。
              maxItems: 14,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['hc_id', 'type', 'value', 'last_modified_ms'],
                properties: {
                  hc_id: UUID,
                  type: { enum: Object.keys(RANGES) },
                  value: { type: 'number' },
                  last_modified_ms: { type: 'integer', minimum: 0, maximum: 1e14 },
                },
              },
            },
          },
        },
      },
      deleted_hc_ids: { type: 'array', maxItems: 500, items: UUID },
      reports: { type: 'array', maxItems: MAX_REPORTS, items: REPORT_SCHEMA },
    },
  },
  '2020-12',
  false,
)

export interface HcRecord {
  hc_id: string
  type: HcType
  value: number
  last_modified_ms: number
}

interface IncomingGroup {
  origin: string
  time_ms: number
  zone_offset_seconds: number | null
  records: HcRecord[]
}

/** 识图报告：schema 保证只有数字；这里只列服务端会读取的字段。 */
export interface HcReport {
  measured_minute_ms: number
  weight_kg: { value: number; min?: number; max?: number }
  [field: string]: unknown
}

export interface IngestPayload {
  schema_version: '1'
  groups: IncomingGroup[]
  deleted_hc_ids: string[]
  reports?: HcReport[]
}

/** 存进 raw_json 的规范形态：键顺序固定、数组有序，内容不变则哈希不变。被删记录连同类型一起保留。 */
export interface HcGroup {
  source: 'health_connect'
  origin: string
  time_ms: number
  zone_offset_seconds: number | null
  records: HcRecord[]
  deleted_records: HcRecord[]
  /** 挂上的识图报告；没有时不写这个键，已存组的哈希不变。 */
  report?: HcReport
}

export interface IngestResult {
  accepted: number
  unchanged: number
  rejected: { time_ms: number; code: string }[]
  deletions_matched: number
  deletions_unmatched: number
}

const keyOf = (timeMs: number) => `hc:${HC_ORIGIN}:${timeMs}`

// 按码点排序（不用 localeCompare），哈希不受运行环境区域设置影响。
const sortRecords = (list: HcRecord[]) =>
  [...list]
    .sort((a, b) => (a.type !== b.type ? (a.type < b.type ? -1 : 1) : a.hc_id < b.hc_id ? -1 : 1))
    .map((r) => ({ hc_id: r.hc_id, type: r.type, value: r.value, last_modified_ms: r.last_modified_ms }))

const canonical = (g: HcGroup): HcGroup => ({
  source: 'health_connect',
  origin: g.origin,
  time_ms: g.time_ms,
  zone_offset_seconds: g.zone_offset_seconds,
  records: sortRecords(g.records),
  deleted_records: sortRecords(g.deleted_records),
  ...(g.report ? { report: JSON.parse(canonicalStringify(g.report)) as HcReport } : {}),
})

/** FitDays+ 写入的是 float，HC 以 double 返回（63.099998474121094）；恰好是 float32 时取能还原它的最短十进制。 */
export function normalizeValue(value: number): number {
  if (Math.fround(value) !== value) return value
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(value.toPrecision(digits))
    if (Math.fround(candidate) === value) return candidate
  }
  return value
}

/** 单组校验：返回拒绝码，通过返回 null。 */
function groupProblem(g: IncomingGroup, acceptAfterMs: number, nowMs: number): string | null {
  if (g.time_ms <= acceptAfterMs) return 'HC_BEFORE_CUTOVER'
  if (g.time_ms > nowMs + FUTURE_SKEW_MS) return 'HC_FUTURE_TIME'
  const types = new Set<string>()
  for (const r of g.records) {
    if (types.has(r.type)) return 'HC_DUPLICATE_TYPE'
    types.add(r.type)
    if (r.type === 'weight' && !inRange('weight', r.value)) return 'HC_VALUE_OUT_OF_RANGE'
  }
  return null
}

/**
 * 合并：已存记录（按 hc_id）的类型、值、修改时间不可变；已删除的 hc_id 不再接收；
 * 新 hc_id 不能与现有或已删除记录同类型（否则泄漏令牌可以先删后补、复活作废的称重）。任何冲突整组拒绝。
 */
export function mergeGroup(stored: HcGroup | undefined, incoming: IncomingGroup): HcGroup | string {
  if (!stored) {
    if (!incoming.records.some((r) => r.type === 'weight')) return 'HC_GROUP_WITHOUT_WEIGHT'
    return canonical({ ...incoming, source: 'health_connect', deleted_records: [] })
  }
  if (stored.zone_offset_seconds !== incoming.zone_offset_seconds) return 'HC_GROUP_CONFLICT'
  const records = [...stored.records]
  for (const r of incoming.records) {
    if (stored.deleted_records.some((x) => x.hc_id === r.hc_id)) continue
    const same = records.find((x) => x.hc_id === r.hc_id)
    if (same) {
      if (same.type !== r.type || same.value !== r.value || same.last_modified_ms !== r.last_modified_ms) {
        return 'HC_GROUP_CONFLICT'
      }
      continue
    }
    if ([...records, ...stored.deleted_records].some((x) => x.type === r.type)) return 'HC_GROUP_CONFLICT'
    records.push(r)
  }
  return canonical({ ...stored, records })
}

const weightOf = (g: HcGroup) => {
  const r = g.records.find((x) => x.type === 'weight')
  return r ? normalizeValue(r.value) : undefined
}
// 报告体重两位小数、体脂一位小数，与 HC 记录同源；容差只吸收浮点误差。
const WEIGHT_TOLERANCE = 0.01 + 1e-9
const BODY_FAT_TOLERANCE = 0.05 + 1e-9

/**
 * 把报告挂到它的那次称重上：同一分钟内（报告时间是 measure_time 截断到分钟）、体重记录仍有效且数值相同的组恰好一个。
 * 不是凭时间相近合并两次称重：报告与 HC 记录来自 FitDays+ 同一条称重，分钟与体重都要对上，多个候选时拒绝。
 * 挂上后不可变：同一组再来不同的报告整条拒绝。返回挂好的组，或拒绝码。
 */
export function attachReport(groups: Iterable<HcGroup>, report: HcReport): HcGroup | string {
  const minute = report.measured_minute_ms
  const candidates = [...groups].filter((g) => {
    const weight = weightOf(g)
    return (
      g.time_ms >= minute &&
      g.time_ms < minute + 60_000 &&
      weight !== undefined &&
      Math.abs(weight - report.weight_kg.value) <= WEIGHT_TOLERANCE
    )
  })
  if (candidates.length === 0) return 'REPORT_NO_MATCH'
  if (candidates.length > 1) return 'REPORT_AMBIGUOUS'
  const target = candidates[0] as HcGroup
  // 原样重发先判：挂上之后才到的 HC 体脂与报告不一致时，重发同一份报告仍应是 unchanged。
  if (target.report) {
    return canonicalStringify(target.report) === canonicalStringify(report) ? target : 'REPORT_CONFLICT'
  }
  // 体脂记录删了也要比：否则先删 HC 体脂再挂报告，就能换一个体脂值。
  const bodyFat = [...target.records, ...target.deleted_records].find((r) => r.type === 'body_fat')
  if (
    bodyFat &&
    typeof report.body_fat_pct === 'number' &&
    Math.abs(normalizeValue(bodyFat.value) - report.body_fat_pct) > BODY_FAT_TOLERANCE
  ) {
    return 'REPORT_MISMATCH'
  }
  return canonical({ ...target, report })
}

const METRICS: Partial<Record<HcType, string>> = {
  weight: 'weight_kg',
  body_fat: 'body_fat_pct',
  bone_mass: 'bone_mass_kg',
  basal_metabolic_rate: 'bmr_kcal',
  heart_rate: 'heart_rate_bpm',
}

/** 报告能补的指标；第三项是 HC 里对应的类型，组里出现过（含已删、越界）该类型时不补。 */
const REPORT_METRICS = (r: HcReport): [string, unknown, HcType?][] => [
  ['body_fat_pct', r.body_fat_pct, 'body_fat'],
  ['bone_mass_kg', (r.bone_mass_kg as { value?: number } | undefined)?.value, 'bone_mass'],
  ['bmr_kcal', r.bmr_kcal, 'basal_metabolic_rate'],
  ['body_water_pct', r.body_water_pct, 'body_water_mass'],
  ['bmi', r.bmi],
  ['muscle_pct', r.muscle_pct],
  ['skeletal_muscle_pct', r.skeletal_muscle_pct],
  ['protein_pct', r.protein_pct],
  ['subcutaneous_fat_pct', r.subcutaneous_fat_pct],
  ['visceral_fat_index', r.visceral_fat_level],
  ['body_age', r.body_age],
  ['smi', r.smi],
  ['whr', r.whr],
]

/** HC_HEIGHT_CM：本人身高（cm），用于推算 BMI；缺失或不在 (50, 250] 时不算。 */
export const heightCm = (env: Env): number | null => {
  const value = Number(env.HC_HEIGHT_CM)
  return Number.isFinite(value) && value > 50 && value <= 250 ? value : null
}

async function prepare(group: HcGroup, profileRef: string, height: number | null): Promise<PreparedRecord> {
  const rawText = JSON.stringify(group)
  const flags = new Set(['source_health_connect'])
  const values = new Map<HcType, number>()
  for (const r of group.records) {
    if (inRange(r.type, r.value)) values.set(r.type, normalizeValue(r.value))
    else flags.add(`${r.type}_out_of_range`)
  }
  const metrics: Record<string, number | null> = {}
  for (const r of group.records) {
    const metric = METRICS[r.type]
    if (metric) metrics[metric] = values.get(r.type) ?? null
  }
  const weight = values.get('weight')
  const water = values.get('body_water_mass')
  if (weight !== undefined && water !== undefined) {
    metrics.body_water_pct = Math.round((water / weight) * 10_000) / 100
    flags.add('body_water_pct_derived_from_mass')
  }
  // FitDays+ 不往 HC 写 BMI；按配置的身高推算，与旧 FitDays 记录一样保留 1 位小数。
  if (weight !== undefined && height !== null) {
    metrics.bmi = Math.round((weight / (height / 100) ** 2) * 10) / 10
    flags.add('bmi_derived_from_height')
  }
  // 报告只补 HC 从没给过的指标，指标名沿用旧 FitDays 记录。HC 有过该类型就不补：
  // 已有或越界的不覆盖，在 HC 里删掉的也不让报告带回来（否则泄漏令牌可以先删后补）。
  const report = group.report
  if (report && weight !== undefined) {
    const hcTypes = new Set([...group.records, ...group.deleted_records].map((r) => r.type))
    for (const [metric, value, hcType] of REPORT_METRICS(report)) {
      if (typeof value !== 'number' || metric in metrics || (hcType && hcTypes.has(hcType))) continue
      metrics[metric] = value
    }
    flags.add('report_attached')
  }
  const measuredAt = Math.floor(group.time_ms / 1000)
  return {
    dataset: 'weight',
    profileRef,
    sourceRecordId: keyOf(group.time_ms),
    identityKind: 'source_id',
    rawText,
    rawHash: await sha256Hex(rawText),
    byteLength: byteLength(rawText),
    redactedPaths: [],
    sourceDataId: group.records.find((r) => r.type === 'weight')?.hc_id ?? null,
    measuredTimeRaw: String(measuredAt),
    measuredAt,
    localDate: localDate(measuredAt * 1000, DEFAULT_TIMEZONE),
    // 体重记录被删除即整次测量作废；其余类型删除只是少一个指标。
    isDeleted: group.records.some((r) => r.type === 'weight') ? 0 : 1,
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

/** 读取当前已发布的 HC 组：按键命中，记录/已删除记录里含请求中的 hc_id，或落在报告所在的那一分钟。 */
async function loadStored(
  db: D1Database,
  ownerId: string,
  profileRef: string,
  keys: string[],
  deletedIds: string[],
  reportMinutes: number[],
): Promise<Map<string, HcGroup>> {
  const rows = await db
    .prepare(
      `SELECT r.source_record_id AS key, v.raw_json AS raw
       FROM raw_records r JOIN raw_record_versions v ON v.id = (
         SELECT lv.id FROM raw_record_versions lv WHERE lv.raw_record_id = r.id AND lv.published = 1
         ORDER BY lv.generation DESC, lv.stage_index DESC LIMIT 1)
       WHERE r.owner_id = ?1 AND r.dataset = 'weight' AND r.profile_ref = ?2 AND r.source_record_id LIKE 'hc:%'
         AND (r.source_record_id IN (SELECT value FROM json_each(?3))
           OR EXISTS (SELECT 1 FROM json_each(v.raw_json, '$.records') e
                      WHERE json_extract(e.value, '$.hc_id') IN (SELECT value FROM json_each(?4)))
           OR EXISTS (SELECT 1 FROM json_each(v.raw_json, '$.deleted_records') d
                      WHERE json_extract(d.value, '$.hc_id') IN (SELECT value FROM json_each(?4)))
           OR EXISTS (SELECT 1 FROM json_each(?5) m
                      WHERE v.measured_at >= m.value AND v.measured_at < m.value + 60))`,
    )
    .bind(
      ownerId,
      profileRef,
      JSON.stringify(keys),
      JSON.stringify(deletedIds),
      JSON.stringify(reportMinutes.map((ms) => ms / 1000)),
    )
    .all<{ key: string; raw: string }>()
  return new Map(rows.results.map((row) => [row.key, JSON.parse(row.raw) as HcGroup]))
}

/** HC_PROFILE_REF 写错会新建一个成员，让所有省略 profile_ref 的体测工具返回 PROFILE_REQUIRED；库里已有成员时必须命中其一。 */
async function profileMatches(db: D1Database, ownerId: string, profileRef: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM profiles WHERE owner_id = ?1) AS any_profile,
              EXISTS (SELECT 1 FROM profiles WHERE owner_id = ?1 AND profile_ref = ?2) AS hit`,
    )
    .bind(ownerId, profileRef)
    .first<{ any_profile: number; hit: number }>()
  return !row?.any_profile || Boolean(row.hit)
}

export async function ingestHealthConnect(
  env: Env,
  ownerId: string,
  profileRef: string,
  acceptAfterMs: number,
  payload: IngestPayload,
  deps: Deps,
): Promise<IngestResult | 'busy' | 'profile_mismatch'> {
  const nowMs = deps.now()
  const result: IngestResult = {
    accepted: 0,
    unchanged: 0,
    rejected: [],
    deletions_matched: 0,
    deletions_unmatched: 0,
  }
  const incoming = new Map<string, IncomingGroup>()
  for (const g of payload.groups) {
    const key = keyOf(g.time_ms)
    const problem = incoming.has(key) ? 'HC_DUPLICATE_GROUP' : groupProblem(g, acceptAfterMs, nowMs)
    if (problem) result.rejected.push({ time_ms: g.time_ms, code: problem })
    else incoming.set(key, g)
  }
  const deletedIds = [...new Set(payload.deleted_hc_ids)]
  const reports = new Map<number, HcReport>()
  for (const r of payload.reports ?? []) {
    if (reports.has(r.measured_minute_ms)) {
      result.rejected.push({ time_ms: r.measured_minute_ms, code: 'REPORT_DUPLICATE' })
    } else reports.set(r.measured_minute_ms, r)
  }
  if (incoming.size === 0 && deletedIds.length === 0 && reports.size === 0) return result

  const db = env.DB
  if (!(await profileMatches(db, ownerId, profileRef))) return 'profile_mismatch'
  const batchId = crypto.randomUUID()
  const generation = await acquireLease(db, ownerId, batchId, nowMs)
  if (generation === null) return 'busy'
  await db
    .prepare(
      `INSERT INTO sync_batches (id, owner_id, mode, state, generation, source_region, attempts, created_at, started_at)
       VALUES (?1, ?2, 'incremental', 'staging', ?3, 'health_connect', 1, ?4, ?4)`,
    )
    .bind(batchId, ownerId, generation, nowMs)
    .run()

  try {
    // 读取在拿到 lease 之后：合并基于的已存版本不会被并发推送改掉。
    const stored = await loadStored(db, ownerId, profileRef, [...incoming.keys()], deletedIds, [
      ...reports.keys(),
    ])
    const next = new Map<string, HcGroup>()
    for (const [key, g] of incoming) {
      const merged = mergeGroup(stored.get(key), g)
      if (typeof merged === 'string') result.rejected.push({ time_ms: g.time_ms, code: merged })
      else next.set(key, merged)
    }
    for (const id of deletedIds) {
      const hit = [...next.entries(), ...stored.entries()].find(([, g]) =>
        [...g.records, ...g.deleted_records].some((r) => r.hc_id === id),
      )
      if (!hit) {
        result.deletions_unmatched++
        continue
      }
      result.deletions_matched++
      const [key, group] = hit
      const record = group.records.find((r) => r.hc_id === id)
      if (!record) continue // 已经删过
      next.set(
        key,
        canonical({
          ...group,
          records: group.records.filter((r) => r.hc_id !== id),
          deleted_records: [...group.deleted_records, record],
        }),
      )
    }
    // 报告在合并与删除之后处理：同一请求里新到的称重可以挂报告，已删的称重不能。
    for (const report of reports.values()) {
      const attached = attachReport(new Map([...stored, ...next]).values(), report)
      if (typeof attached === 'string') {
        result.rejected.push({ time_ms: report.measured_minute_ms, code: attached })
      } else next.set(keyOf(attached.time_ms), attached)
    }

    const height = heightCm(env)
    const records = await Promise.all([...next.values()].map((g) => prepare(g, profileRef, height)))
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
    result.unchanged = next.size - staged.versionCount
    await db
      .prepare('UPDATE sync_batches SET counts_json = ? WHERE id = ?')
      .bind(
        JSON.stringify({
          weight: staged.versionCount,
          rejected: result.rejected.length,
          deletions_matched: result.deletions_matched,
          deletions_unmatched: result.deletions_unmatched,
        }),
        batchId,
      )
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

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })

export async function handleIngest(request: Request, env: Env, deps: Deps): Promise<Response> {
  const expected = env.HC_INGEST_TOKEN_SHA256?.trim().toLowerCase()
  // 未配置令牌或方法不对时与不存在的路径表现一致。
  if (request.method !== 'POST' || !expected) return new Response('Not found', { status: 404 })
  const started = deps.now()
  try {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    await consumeRateLimit(env.DB, `ingest:${ip}`, RATE_LIMIT_PER_IP_PER_MINUTE, 60, started)

    const header = request.headers.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!token || !constantTimeEqual(await sha256Hex(token), expected)) {
      logEvent({ event: 'ingest', status: 'unauthorized' })
      return reply(401, { error: 'unauthorized' })
    }
    // 全局计数放在鉴权之后：未授权的请求再多也挤不掉本人设备的额度。
    await consumeRateLimit(env.DB, 'ingest:all', RATE_LIMIT_GLOBAL_PER_MINUTE, 60, started)
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
    // schema 只允许 UUID、枚举、固定来源与数字；秘密检查是写入输入的统一底线。
    if (!validator.validate(payload).valid || findSecretPath(payload)) {
      return reply(400, { error: 'invalid_payload' })
    }
    const acceptAfterMs = parseInstant(env.HC_ACCEPT_AFTER ?? '')
    if (acceptAfterMs === null || !env.HC_PROFILE_REF) return reply(503, { error: 'not_configured' })

    const result = await ingestHealthConnect(
      env,
      env.OWNER_ID,
      env.HC_PROFILE_REF,
      acceptAfterMs,
      payload as IngestPayload,
      deps,
    )
    if (result === 'busy' || result === 'profile_mismatch') {
      logEvent({ event: 'ingest', status: result })
      return result === 'busy'
        ? reply(503, { error: 'busy' }, { 'retry-after': '10' })
        : reply(503, { error: 'not_configured' })
    }
    logEvent({
      event: 'ingest',
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
      event: 'ingest',
      status: 'failed',
      code: error instanceof KtError ? error.code : 'STORAGE_FAILED',
      category: error instanceof Error ? error.name : 'unknown',
    })
    return reply(500, { error: 'storage_failed' })
  }
}
