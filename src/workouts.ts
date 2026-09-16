// 训练事实：只写 Kinetrail 自己的库。每个写操作 = 鉴权（在 mcp 层）→ 收据查重 → 校验 → 单个 D1 batch
// 原子提交 event / entry version / session revision / receipt。CAS 冲突由 guard 表约束显式失败。

import { type CursorState, decodeCursor, encodeCursor, queryHash } from './cursor'
import type { ToolContext, ToolOutcome } from './mcp'
import { PAGE_BYTE_BUDGET, parseRange } from './queries'
import { findSecretPath } from './sanitize'
import {
  byteLength,
  canonicalStringify,
  DEFAULT_TIMEZONE,
  isoInZone,
  isValidTimeZone,
  KtError,
  localDate,
  parseInstant,
  sha256Hex,
} from './util'

export const WORKOUT_SCHEMA_VERSION = '1'
export const PARSER_VERSION = 'server_rules_v1'
export const WORKOUT_NORMALIZATION_VERSION = '1'

// ponytail: 自动选择会话的阈值是产品默认值，不是训练规律；真实使用（G5）后再校准。
export const SESSION_POLICY = {
  maxInactivityMs: 12 * 3600_000,
  maxSessionAgeMs: 18 * 3600_000,
  backfillToleranceMs: 3600_000,
  futureSkewMs: 5 * 60_000,
}

// ───────────── 类型 ─────────────
export interface SetInput {
  load_original?: { value: number | string; unit: string }
  distance_original?: { value: number | string; unit: string }
  speed_original?: { value: number | string; unit: string }
  assistance_value?: number
  assistance_unit?: 'kg' | 'lb'
  set_type?: 'warmup' | 'working' | 'drop' | 'failure' | 'other'
  load_value?: number
  load_unit?: 'kg' | 'lb'
  load_basis?: 'total_external' | 'per_hand' | 'bodyweight' | 'assisted' | 'unknown'
  reps?: number
  duration_seconds?: number
  distance_value?: number
  distance_unit?: 'm' | 'km' | 'mi'
  speed?: number
  speed_unit?: 'm/s' | 'km/h' | 'mph'
  incline_pct?: number
  resistance?: number | string
  resistance_unit?: string
  power_watts?: number
  rpe?: number
  rir?: number
  heart_rate_avg?: number
  heart_rate_max?: number
  notes?: string
}

export interface EntryInput {
  exercise_name_raw: string
  exercise_id?: string
  category: 'strength' | 'cardio' | 'mobility' | 'other'
  equipment_ref?: string
  equipment_label?: string
  facility?: string
  sets: SetInput[]
  notes?: string
}

export interface NormalizedSet {
  load_kg: number | null
  assistance_kg: number | null
  distance_m: number | null
  speed_mps: number | null
  quality_flags: string[]
}

export interface StoredEntry extends EntryInput {
  normalization_version: string
  normalized_sets: NormalizedSet[]
}

interface SessionRow {
  id: string
  owner_id: string
  status: 'open' | 'finalized'
  revision: number
  started_at: string
  started_at_ms: number
  started_explicitly: number
  ended_at: string | null
  ended_at_ms: number | null
  timezone: string
  facility: string | null
  duration_seconds: number | null
  duration_source: 'user_reported' | 'timestamps' | 'unknown'
  overall_rpe: number | null
  calories_kcal: number | null
  notes: string | null
  last_activity_ms: number
  created_at: number
}

interface EntryVersionRow {
  id: string
  entry_id: string
  session_id: string
  version: number
  supersedes_version: number | null
  state: 'active' | 'retracted'
  sequence: number
  occurred_at: string
  occurred_at_ms: number
  local_date: string
  raw_text: string
  entry_json: string
  created_at: number
}

export interface Receipt {
  session_id: string
  event_id: string
  entry_ids: string[]
  revision: number
  committed_at: string
  idempotency_key: string
}

interface WriteBase {
  idempotency_key: string
  expected_revision: number
  raw_text: string
}

// ───────────── 校验与归一化 ─────────────
const KG_PER_LB = 0.45359237
const LOAD_UNITS: Record<string, number> = {
  kg: 1,
  公斤: 1,
  千克: 1,
  lb: KG_PER_LB,
  lbs: KG_PER_LB,
  磅: KG_PER_LB,
}
const DISTANCE_UNITS: Record<string, number> = {
  m: 1,
  米: 1,
  km: 1000,
  公里: 1000,
  千米: 1000,
  mi: 1609.344,
  英里: 1609.344,
}
const SPEED_UNITS: Record<string, number> = { 'm/s': 1, 'km/h': 1 / 3.6, 公里每小时: 1 / 3.6, mph: 0.44704 }

const FUTURE = /(明天|明早|明晚|后天|下次|下周|下个月|改天|tomorrow|next time|next week)/i
const INTENT =
  /(待会|等会|等一下|一会儿|稍后|晚点|准备(?!组|活动)|打算|计划|将要|想要|要去|想去|plan(ning)? to|going to|gonna|will do)/i
const ADVICE = /(建议|推荐|应该做|你觉得|要不要|怎么安排|should i|recommend|suggest)/i
const HYPOTHETICAL = /(假如|如果|要是|假设|万一|\bif i\b|suppose)/i
const NEGATION =
  /(没做|没有做|没练|没去|没完成|未完成|没能|做不了|不做了|跳过了|取消了|放弃了|didn'?t|did not|haven'?t|skipped)/i
const OTHERS = /(朋友|同事|他做|她做|他们做|别人|教练(做|示范)|my friend|he did|she did)/i

/** 服务端矛盾检查：命中即不写入。不能证明完成，只能挡住明显的计划/建议/假设/否定/他人。 */
function assertCompletionPlausible(rawText: string, rules: RegExp[]): void {
  const hit = rules.find((re) => re.test(rawText))
  if (hit) {
    const category = ['future', 'intent', 'advice', 'hypothetical', 'negation', 'others'][
      [FUTURE, INTENT, ADVICE, HYPOTHETICAL, NEGATION, OTHERS].indexOf(hit)
    ]
    throw new KtError('NEEDS_CLARIFICATION', { category })
  }
}

const DATA_FIELDS: (keyof SetInput)[] = [
  'load_value',
  'load_original',
  'reps',
  'duration_seconds',
  'distance_value',
  'distance_original',
  'speed',
  'speed_original',
  'assistance_value',
  'power_watts',
  'resistance',
]

function convertOriginal(
  original: { value: number | string; unit: string } | undefined,
  table: Record<string, number>,
) {
  if (!original) return { value: null, flag: null }
  const unit = [original.unit.trim().toLowerCase(), original.unit.trim()].find((u) => Object.hasOwn(table, u))
  const factor = unit === undefined ? undefined : table[unit]
  const numeric = typeof original.value === 'number' ? original.value : Number(original.value)
  if (factor === undefined || !Number.isFinite(numeric)) return { value: null, flag: 'unknown_original_unit' }
  return { value: numeric * factor, flag: 'converted_from_original' }
}

export function normalizeEntry(entry: EntryInput): StoredEntry {
  const normalized = entry.sets.map((set) => {
    if (!DATA_FIELDS.some((field) => set[field] !== undefined)) {
      throw new KtError('INVALID_INPUT', { category: 'empty_set' })
    }
    const pairs: [unknown, unknown][] = [
      [set.load_value, set.load_unit],
      [set.distance_value, set.distance_unit],
      [set.speed, set.speed_unit],
      [set.assistance_value, set.assistance_unit],
    ]
    if (pairs.some(([value, unit]) => (value === undefined) !== (unit === undefined))) {
      throw new KtError('INVALID_UNIT')
    }
    if (set.resistance_unit !== undefined && set.resistance === undefined) throw new KtError('INVALID_UNIT')

    const flags = new Set<string>()
    const pick = (
      value: number | undefined,
      unit: string | undefined,
      original: SetInput['load_original'],
      table: Record<string, number>,
      unknownFlag: string,
    ) => {
      if (value !== undefined && unit !== undefined) return value * (table[unit] ?? Number.NaN)
      const converted = convertOriginal(original, table)
      if (converted.flag) flags.add(converted.flag === 'unknown_original_unit' ? unknownFlag : converted.flag)
      return converted.value
    }
    const load = pick(set.load_value, set.load_unit, set.load_original, LOAD_UNITS, 'unknown_load_unit')
    const distance = pick(
      set.distance_value,
      set.distance_unit,
      set.distance_original,
      DISTANCE_UNITS,
      'unknown_distance_unit',
    )
    const speed = pick(set.speed, set.speed_unit, set.speed_original, SPEED_UNITS, 'unknown_speed_unit')
    const assistance =
      set.assistance_value !== undefined && set.assistance_unit
        ? set.assistance_value * (LOAD_UNITS[set.assistance_unit] ?? 1)
        : null

    if (speed !== null && distance !== null && set.duration_seconds) {
      const implied = distance / set.duration_seconds
      if (implied > 0 && Math.abs(implied - speed) / implied > 0.15)
        flags.add('speed_distance_time_inconsistent')
    }
    for (const hr of [set.heart_rate_avg, set.heart_rate_max]) {
      if (hr !== undefined && (hr < 25 || hr > 250)) flags.add('heart_rate_out_of_range')
    }
    if (set.power_watts !== undefined && set.power_watts > 3000) flags.add('power_out_of_range')
    if (set.load_basis === 'assisted' && set.load_value !== undefined && set.assistance_value === undefined) {
      flags.add('assisted_load_semantics_unclear')
    }
    return {
      load_kg: load,
      assistance_kg: assistance,
      distance_m: distance,
      speed_mps: speed,
      quality_flags: [...flags].sort(),
    }
  })
  return { ...entry, normalization_version: WORKOUT_NORMALIZATION_VERSION, normalized_sets: normalized }
}

function instant(text: string, nowMs: number, field: string): number {
  const ms = parseInstant(text)
  if (ms === null) throw new KtError('INVALID_INPUT', { category: `${field}_format` })
  if (ms > nowMs + SESSION_POLICY.futureSkewMs)
    throw new KtError('INVALID_INPUT', { category: `${field}_in_future` })
  return ms
}

function timezoneOf(tz: string | undefined): string {
  const zone = tz ?? DEFAULT_TIMEZONE
  if (!isValidTimeZone(zone)) throw new KtError('INVALID_INPUT', { category: 'timezone' })
  return zone
}

// ───────────── 幂等与提交 ─────────────
async function payloadHash(tool: string, args: Record<string, unknown>): Promise<string> {
  const { idempotency_key: _ignored, ...rest } = args
  return sha256Hex(canonicalStringify({ tool, args: rest }))
}

interface StoredOutcome {
  receipt: Receipt
  summary: string
}

async function readReceipt(db: D1Database, ownerId: string, key: string) {
  return db
    .prepare(
      'SELECT tool_name, payload_hash, outcome_json FROM write_receipts WHERE owner_id = ? AND idempotency_key = ?',
    )
    .bind(ownerId, key)
    .first<{ tool_name: string; payload_hash: string; outcome_json: string }>()
}

function replay(
  prior: { tool_name: string; payload_hash: string; outcome_json: string },
  tool: string,
  hash: string,
): ToolOutcome {
  if (prior.tool_name !== tool || prior.payload_hash !== hash) throw new KtError('IDEMPOTENCY_CONFLICT')
  const stored = JSON.parse(prior.outcome_json) as StoredOutcome
  return { data: stored.receipt, summary: `${stored.summary}（重复请求，返回首次提交的收据，未重复写入）` }
}

const isConstraintError = (error: unknown) =>
  error instanceof Error && /constraint failed|SQLITE_CONSTRAINT/i.test(error.message)

async function loadSession(db: D1Database, ownerId: string, sessionId: string): Promise<SessionRow> {
  const row = await db
    .prepare('SELECT * FROM workout_sessions WHERE id = ? AND owner_id = ?')
    .bind(sessionId, ownerId)
    .first<SessionRow>()
  if (!row) throw new KtError('NOT_FOUND')
  return row
}

interface CommitPlan {
  statements: (receiptStatement: D1PreparedStatement) => D1PreparedStatement[]
  receipt: Receipt
  summary: string
  /** 约束失败后重新读取状态，给出准确的冲突错误。 */
  explainConflict: () => Promise<KtError>
}

async function runWrite(
  ctx: ToolContext,
  tool: string,
  args: WriteBase & Record<string, unknown>,
  plan: (hash: string, nowMs: number) => Promise<CommitPlan>,
): Promise<ToolOutcome> {
  const db = ctx.env.DB
  const hash = await payloadHash(tool, args)
  const prior = await readReceipt(db, ctx.ownerId, args.idempotency_key)
  if (prior) return replay(prior, tool, hash)
  // 与读工具输出前的检查同一规则：任何字段（原话、备注、原始单位、器械名……）带邮箱/URL/JWT 等都不入库，
  // 否则写入成功后该历史页会永久被输出检查拦截。
  if (findSecretPath(args)) throw new KtError('SENSITIVE_PAYLOAD_BLOCKED', { category: 'workout_input' })

  const nowMs = ctx.deps.now()
  const built = await plan(hash, nowMs)
  const outcome: StoredOutcome = { receipt: built.receipt, summary: built.summary }
  const receiptStatement = db
    .prepare(
      'INSERT INTO write_receipts (owner_id, idempotency_key, tool_name, payload_hash, outcome_json, committed_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(ctx.ownerId, args.idempotency_key, tool, hash, JSON.stringify(outcome), nowMs)
  try {
    await db.batch(built.statements(receiptStatement))
  } catch (error) {
    const after = await readReceipt(db, ctx.ownerId, args.idempotency_key).catch(() => undefined)
    if (after) return replay(after, tool, hash)
    if (after === undefined)
      throw new KtError('COMMIT_STATUS_UNKNOWN', { persistence: 'unknown', retryable: true })
    if (isConstraintError(error)) throw await built.explainConflict()
    throw new KtError('COMMIT_STATUS_UNKNOWN', {
      persistence: 'unknown',
      retryable: true,
      category: 'batch_error',
    })
  }
  return { data: built.receipt, summary: built.summary }
}

const guardSession = (
  db: D1Database,
  sessionId: string,
  ownerId: string,
  revision: number,
  status?: string,
) =>
  db
    .prepare(
      `INSERT INTO guard (ok) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM workout_sessions
       WHERE id = ? AND owner_id = ? AND revision = ? ${status ? 'AND status = ?' : 'AND ? IS NULL'})`,
    )
    .bind(sessionId, ownerId, revision, status ?? null)

function eventStatement(
  db: D1Database,
  e: {
    id: string
    ownerId: string
    sessionId: string
    operation: string
    occurredAt: string
    occurredMs: number
    timezone: string
    rawText: string
    completion: string | null
    parsed: unknown
    key: string
    hash: string
    previous: number
    resulting: number
    nowMs: number
  },
) {
  return db
    .prepare(
      `INSERT INTO workout_events (id, owner_id, session_id, operation, occurred_at, occurred_at_ms, local_date, raw_text,
         completion_assertion, evidence_origin, parsed_json, schema_version, parser_version, idempotency_key, payload_hash,
         previous_revision, resulting_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_report_via_model', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      e.id,
      e.ownerId,
      e.sessionId,
      e.operation,
      e.occurredAt,
      e.occurredMs,
      localDate(e.occurredMs, e.timezone),
      e.rawText,
      e.completion,
      JSON.stringify(e.parsed),
      WORKOUT_SCHEMA_VERSION,
      PARSER_VERSION,
      e.key,
      e.hash,
      e.previous,
      e.resulting,
      e.nowMs,
    )
}

const committedAt = (nowMs: number, tz: string) => isoInZone(nowMs, tz)

async function conflictFor(
  db: D1Database,
  ownerId: string,
  sessionId: string,
  expected: number,
  needStatus?: string,
) {
  const current = await db
    .prepare('SELECT revision, status FROM workout_sessions WHERE id = ? AND owner_id = ?')
    .bind(sessionId, ownerId)
    .first<{ revision: number; status: string }>()
  if (!current) return new KtError('NOT_FOUND')
  if (current.revision !== expected)
    return new KtError('REVISION_CONFLICT', { currentRevision: current.revision })
  if (needStatus === 'open' && current.status !== 'open') return new KtError('SESSION_FINALIZED')
  return new KtError('STORAGE_FAILED', { category: 'constraint' })
}

// ───────────── 会话选择 ─────────────
function autoEligible(session: SessionRow, nowMs: number): boolean {
  return (
    nowMs - session.last_activity_ms <= SESSION_POLICY.maxInactivityMs &&
    nowMs - session.started_at_ms <= SESSION_POLICY.maxSessionAgeMs
  )
}

async function openSessions(db: D1Database, ownerId: string): Promise<SessionRow[]> {
  const rows = await db
    .prepare(
      "SELECT * FROM workout_sessions WHERE owner_id = ? AND status = 'open' ORDER BY started_at_ms, id",
    )
    .bind(ownerId)
    .all<SessionRow>()
  return rows.results
}

// ───────────── 写工具 ─────────────
interface StartArgs extends WriteBase {
  started_at: string
  timezone: string
  facility?: string
}

export async function startWorkoutSession(args: StartArgs, ctx: ToolContext): Promise<ToolOutcome> {
  return runWrite(
    ctx,
    'start_workout_session',
    args as StartArgs & Record<string, unknown>,
    async (hash, nowMs) => {
      if (args.expected_revision !== 0) throw new KtError('INVALID_INPUT', { category: 'start_revision' })
      const tz = timezoneOf(args.timezone)
      const startedMs = instant(args.started_at, nowMs, 'started_at')
      assertCompletionPlausible(args.raw_text, [FUTURE, ADVICE, HYPOTHETICAL, NEGATION, OTHERS])
      const db = ctx.env.DB
      const sessionId = crypto.randomUUID()
      const eventId = crypto.randomUUID()
      const receipt: Receipt = {
        session_id: sessionId,
        event_id: eventId,
        entry_ids: [],
        revision: 1,
        committed_at: committedAt(nowMs, tz),
        idempotency_key: args.idempotency_key,
      }
      return {
        receipt,
        summary: `已开始训练会话 ${sessionId}（尚未记录任何完成的组）。`,
        explainConflict: async () => new KtError('STORAGE_FAILED', { category: 'constraint' }),
        statements: (receiptStatement) => [
          db
            .prepare(
              `INSERT INTO workout_sessions (id, owner_id, status, revision, started_at, started_at_ms, started_explicitly,
               timezone, facility, last_activity_ms, created_at, updated_at)
             VALUES (?, ?, 'open', 1, ?, ?, 1, ?, ?, ?, ?, ?)`,
            )
            .bind(
              sessionId,
              ctx.ownerId,
              args.started_at,
              startedMs,
              tz,
              args.facility ?? null,
              startedMs,
              nowMs,
              nowMs,
            ),
          eventStatement(db, {
            id: eventId,
            ownerId: ctx.ownerId,
            sessionId,
            operation: 'start',
            occurredAt: args.started_at,
            occurredMs: startedMs,
            timezone: tz,
            rawText: args.raw_text,
            completion: null,
            parsed: { facility: args.facility ?? null },
            key: args.idempotency_key,
            hash,
            previous: 0,
            resulting: 1,
            nowMs,
          }),
          receiptStatement,
        ],
      }
    },
  )
}

interface RecordArgs extends WriteBase {
  session_id?: string
  occurred_at: string
  timezone: string
  completion: 'completed'
  entries: EntryInput[]
}

export async function recordWorkoutEvent(args: RecordArgs, ctx: ToolContext): Promise<ToolOutcome> {
  return runWrite(
    ctx,
    'record_workout_event',
    args as RecordArgs & Record<string, unknown>,
    async (hash, nowMs) => {
      if (args.completion !== 'completed')
        throw new KtError('NEEDS_CLARIFICATION', { category: 'completion' })
      const tz = timezoneOf(args.timezone)
      const occurredMs = instant(args.occurred_at, nowMs, 'occurred_at')
      assertCompletionPlausible(args.raw_text, [FUTURE, INTENT, ADVICE, HYPOTHETICAL, NEGATION, OTHERS])
      const stored = args.entries.map(normalizeEntry)
      const db = ctx.env.DB
      const facilities = [
        ...new Set(args.entries.map((e) => e.facility).filter((f): f is string => Boolean(f))),
      ]

      let session: SessionRow | null = null
      if (args.session_id) {
        session = await loadSession(db, ctx.ownerId, args.session_id)
        if (session.status !== 'open') throw new KtError('SESSION_FINALIZED')
      } else {
        const opens = await openSessions(db, ctx.ownerId)
        if (opens.length > 1) throw new KtError('SESSION_AMBIGUOUS')
        if (opens.length === 1) {
          const only = opens[0] as SessionRow
          const facilityOk = !only.facility || facilities.every((f) => f === only.facility)
          if (!autoEligible(only, nowMs) || !facilityOk) throw new KtError('SESSION_SELECTION_REQUIRED')
          session = only
        }
      }
      if (session && occurredMs < session.started_at_ms - SESSION_POLICY.backfillToleranceMs) {
        // 补录过去的训练不能串进当前会话。
        throw new KtError('SESSION_SELECTION_REQUIRED', { category: 'backfill_before_session' })
      }
      const currentRevision = session?.revision ?? 0
      if (args.expected_revision !== currentRevision) {
        throw new KtError('REVISION_CONFLICT', { currentRevision })
      }

      const sessionId = session?.id ?? crypto.randomUUID()
      const eventId = crypto.randomUUID()
      const nextRevision = currentRevision + 1
      const seqRow = session
        ? await db
            .prepare(
              'SELECT COALESCE(MAX(sequence), 0) AS s FROM workout_entry_versions WHERE session_id = ?',
            )
            .bind(sessionId)
            .first<{ s: number }>()
        : { s: 0 }
      const entryIds = stored.map(() => crypto.randomUUID())
      const receipt: Receipt = {
        session_id: sessionId,
        event_id: eventId,
        entry_ids: entryIds,
        revision: nextRevision,
        committed_at: committedAt(nowMs, tz),
        idempotency_key: args.idempotency_key,
      }
      const names = stored.map((e) => `${e.exercise_name_raw}×${e.sets.length}组`).join('、')
      // 不同键、相同原话：可能是重复汇报，也可能真的又做了一次。照常保存，只提示确认，不静默吞掉。
      const duplicate = session
        ? await db
            .prepare(
              "SELECT 1 FROM workout_entry_versions WHERE session_id = ? AND raw_text = ? AND state = 'active' LIMIT 1",
            )
            .bind(session.id, args.raw_text)
            .first()
        : null
      const numbersInText = stored
        .flatMap((e) => e.sets.flatMap((s) => [s.load_value, s.reps, s.duration_seconds, s.distance_value]))
        .filter((n): n is number => n !== undefined)
        .every((n) => args.raw_text.includes(String(n)))

      return {
        receipt,
        summary: `已保存到会话 ${sessionId}：${names}（事件 ${eventId}，修订 ${nextRevision}）。${
          duplicate
            ? '注意：本会话已有相同原话的记录，疑似重复汇报；若确是重复，请向用户确认后用 amend 撤回。'
            : ''
        }`,
        explainConflict: async () => {
          if (session) return conflictFor(db, ctx.ownerId, sessionId, currentRevision, 'open')
          const now = await openSessions(db, ctx.ownerId)
          if (now.length === 1)
            return new KtError('REVISION_CONFLICT', { currentRevision: (now[0] as SessionRow).revision })
          return new KtError(now.length > 1 ? 'SESSION_AMBIGUOUS' : 'STORAGE_FAILED', {
            category: 'constraint',
          })
        },
        statements: (receiptStatement) => {
          const list: D1PreparedStatement[] = []
          if (session) {
            list.push(
              guardSession(db, sessionId, ctx.ownerId, currentRevision, 'open'),
              db
                .prepare(
                  `UPDATE workout_sessions SET revision = revision + 1, last_activity_ms = MAX(last_activity_ms, ?), updated_at = ?
                 WHERE id = ? AND owner_id = ? AND revision = ?`,
                )
                .bind(occurredMs, nowMs, sessionId, ctx.ownerId, currentRevision),
            )
          } else {
            list.push(
              // 并发创建：提交时若已有 open 会话则整体回滚，避免一轮聊天生出两个隐形会话。
              db
                .prepare(
                  "INSERT INTO guard (ok) SELECT NULL WHERE EXISTS (SELECT 1 FROM workout_sessions WHERE owner_id = ? AND status = 'open')",
                )
                .bind(ctx.ownerId),
              db
                .prepare(
                  `INSERT INTO workout_sessions (id, owner_id, status, revision, started_at, started_at_ms, started_explicitly,
                   timezone, facility, last_activity_ms, created_at, updated_at)
                 VALUES (?, ?, 'open', 1, ?, ?, 0, ?, ?, ?, ?, ?)`,
                )
                .bind(
                  sessionId,
                  ctx.ownerId,
                  args.occurred_at,
                  occurredMs,
                  tz,
                  facilities.length === 1 ? facilities[0] : null,
                  occurredMs,
                  nowMs,
                  nowMs,
                ),
            )
          }
          list.push(
            eventStatement(db, {
              id: eventId,
              ownerId: ctx.ownerId,
              sessionId,
              operation: 'record',
              occurredAt: args.occurred_at,
              occurredMs,
              timezone: tz,
              rawText: args.raw_text,
              completion: 'completed',
              parsed: {
                entries: stored,
                checks: { numbers_in_raw_text: numbersInText },
                created_session: !session,
              },
              key: args.idempotency_key,
              hash,
              previous: currentRevision,
              resulting: nextRevision,
              nowMs,
            }),
          )
          stored.forEach((entry, i) => {
            list.push(
              db
                .prepare(
                  `INSERT INTO workout_entry_versions (id, entry_id, owner_id, session_id, event_id, version, supersedes_version,
                   state, sequence, occurred_at, occurred_at_ms, local_date, raw_text, entry_json, created_at)
                 VALUES (?, ?, ?, ?, ?, 1, NULL, 'active', ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                  crypto.randomUUID(),
                  entryIds[i],
                  ctx.ownerId,
                  sessionId,
                  eventId,
                  (seqRow?.s ?? 0) + i + 1,
                  args.occurred_at,
                  occurredMs,
                  localDate(occurredMs, tz),
                  args.raw_text,
                  JSON.stringify(entry),
                  nowMs,
                ),
            )
          })
          list.push(receiptStatement)
          return list
        },
      }
    },
  )
}

interface FinalizeArgs extends WriteBase {
  session_id: string
  ended_at: string
  duration_seconds?: number
  overall_rpe?: number
  calories_kcal?: number
  notes?: string
}

export async function finalizeWorkoutSession(args: FinalizeArgs, ctx: ToolContext): Promise<ToolOutcome> {
  return runWrite(
    ctx,
    'finalize_workout_session',
    args as FinalizeArgs & Record<string, unknown>,
    async (hash, nowMs) => {
      const db = ctx.env.DB
      const session = await loadSession(db, ctx.ownerId, args.session_id)
      if (session.status !== 'open') throw new KtError('SESSION_FINALIZED')
      if (session.revision !== args.expected_revision) {
        throw new KtError('REVISION_CONFLICT', { currentRevision: session.revision })
      }
      const endedMs = instant(args.ended_at, nowMs, 'ended_at')
      if (endedMs < session.started_at_ms)
        throw new KtError('INVALID_INPUT', { category: 'ended_before_start' })
      const durationSource =
        args.duration_seconds !== undefined
          ? 'user_reported'
          : session.started_explicitly
            ? 'timestamps'
            : 'unknown'
      const duration =
        args.duration_seconds ??
        (durationSource === 'timestamps' ? Math.floor((endedMs - session.started_at_ms) / 1000) : null)
      const eventId = crypto.randomUUID()
      const next = session.revision + 1
      const receipt: Receipt = {
        session_id: session.id,
        event_id: eventId,
        entry_ids: [],
        revision: next,
        committed_at: committedAt(nowMs, session.timezone),
        idempotency_key: args.idempotency_key,
      }
      return {
        receipt,
        summary: `已结束训练会话 ${session.id}（修订 ${next}）。`,
        explainConflict: () => conflictFor(db, ctx.ownerId, session.id, session.revision, 'open'),
        statements: (receiptStatement) => [
          guardSession(db, session.id, ctx.ownerId, session.revision, 'open'),
          db
            .prepare(
              `UPDATE workout_sessions SET status = 'finalized', revision = revision + 1, ended_at = ?, ended_at_ms = ?,
               duration_seconds = ?, duration_source = ?, overall_rpe = ?, calories_kcal = ?, notes = ?, updated_at = ?
             WHERE id = ? AND owner_id = ? AND revision = ?`,
            )
            .bind(
              args.ended_at,
              endedMs,
              duration,
              durationSource,
              args.overall_rpe ?? null,
              args.calories_kcal ?? null,
              args.notes ?? null,
              nowMs,
              session.id,
              ctx.ownerId,
              session.revision,
            ),
          eventStatement(db, {
            id: eventId,
            ownerId: ctx.ownerId,
            sessionId: session.id,
            operation: 'finalize',
            occurredAt: args.ended_at,
            occurredMs: endedMs,
            timezone: session.timezone,
            rawText: args.raw_text,
            completion: null,
            parsed: {
              duration_seconds: duration,
              duration_source: durationSource,
              overall_rpe: args.overall_rpe ?? null,
              calories_kcal: args.calories_kcal ?? null,
              notes: args.notes ?? null,
            },
            key: args.idempotency_key,
            hash,
            previous: session.revision,
            resulting: next,
            nowMs,
          }),
          receiptStatement,
        ],
      }
    },
  )
}

interface ReopenArgs extends WriteBase {
  session_id: string
}

export async function reopenWorkoutSession(args: ReopenArgs, ctx: ToolContext): Promise<ToolOutcome> {
  return runWrite(
    ctx,
    'reopen_workout_session',
    args as ReopenArgs & Record<string, unknown>,
    async (hash, nowMs) => {
      const db = ctx.env.DB
      const session = await loadSession(db, ctx.ownerId, args.session_id)
      if (session.revision !== args.expected_revision) {
        throw new KtError('REVISION_CONFLICT', { currentRevision: session.revision })
      }
      if (session.status !== 'finalized')
        throw new KtError('INVALID_INPUT', { category: 'session_not_finalized' })
      const eventId = crypto.randomUUID()
      const next = session.revision + 1
      const receipt: Receipt = {
        session_id: session.id,
        event_id: eventId,
        entry_ids: [],
        revision: next,
        committed_at: committedAt(nowMs, session.timezone),
        idempotency_key: args.idempotency_key,
      }
      return {
        receipt,
        summary: `已重新打开训练会话 ${session.id}（修订 ${next}）。`,
        explainConflict: () => conflictFor(db, ctx.ownerId, session.id, session.revision),
        statements: (receiptStatement) => [
          guardSession(db, session.id, ctx.ownerId, session.revision, 'finalized'),
          db
            .prepare(
              `UPDATE workout_sessions SET status = 'open', revision = revision + 1, ended_at = NULL, ended_at_ms = NULL,
               last_activity_ms = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ?`,
            )
            .bind(nowMs, nowMs, session.id, ctx.ownerId, session.revision),
          eventStatement(db, {
            id: eventId,
            ownerId: ctx.ownerId,
            sessionId: session.id,
            operation: 'reopen',
            occurredAt: isoInZone(nowMs, session.timezone),
            occurredMs: nowMs,
            timezone: session.timezone,
            rawText: args.raw_text,
            completion: null,
            parsed: { previous_ended_at: session.ended_at },
            key: args.idempotency_key,
            hash,
            previous: session.revision,
            resulting: next,
            nowMs,
          }),
          receiptStatement,
        ],
      }
    },
  )
}

interface AmendArgs extends WriteBase {
  session_id: string
  entry_id: string
  replacement: EntryInput
  state: 'active' | 'retracted'
}

export async function amendWorkoutEntry(args: AmendArgs, ctx: ToolContext): Promise<ToolOutcome> {
  return runWrite(
    ctx,
    'amend_workout_entry',
    args as AmendArgs & Record<string, unknown>,
    async (hash, nowMs) => {
      const db = ctx.env.DB
      const session = await loadSession(db, ctx.ownerId, args.session_id)
      const latest = await db
        .prepare(
          'SELECT * FROM workout_entry_versions WHERE entry_id = ? AND session_id = ? AND owner_id = ? ORDER BY version DESC LIMIT 1',
        )
        .bind(args.entry_id, session.id, ctx.ownerId)
        .first<EntryVersionRow>()
      if (!latest) throw new KtError('NOT_FOUND')
      if (session.revision !== args.expected_revision) {
        throw new KtError('REVISION_CONFLICT', { currentRevision: session.revision })
      }
      const stored = normalizeEntry(args.replacement)
      const eventId = crypto.randomUUID()
      const next = session.revision + 1
      const receipt: Receipt = {
        session_id: session.id,
        event_id: eventId,
        entry_ids: [args.entry_id],
        revision: next,
        committed_at: committedAt(nowMs, session.timezone),
        idempotency_key: args.idempotency_key,
      }
      return {
        receipt,
        summary: `已${args.state === 'retracted' ? '撤回' : '修正'}动作 ${args.entry_id}，旧版本保留（修订 ${next}）。`,
        explainConflict: () => conflictFor(db, ctx.ownerId, session.id, session.revision),
        statements: (receiptStatement) => [
          guardSession(db, session.id, ctx.ownerId, session.revision),
          db
            .prepare(
              'UPDATE workout_sessions SET revision = revision + 1, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ?',
            )
            .bind(nowMs, session.id, ctx.ownerId, session.revision),
          eventStatement(db, {
            id: eventId,
            ownerId: ctx.ownerId,
            sessionId: session.id,
            operation: 'amend',
            occurredAt: isoInZone(nowMs, session.timezone),
            occurredMs: nowMs,
            timezone: session.timezone,
            rawText: args.raw_text,
            completion: null,
            parsed: {
              entry_id: args.entry_id,
              supersedes_version: latest.version,
              state: args.state,
              replacement: stored,
            },
            key: args.idempotency_key,
            hash,
            previous: session.revision,
            resulting: next,
            nowMs,
          }),
          db
            .prepare(
              `INSERT INTO workout_entry_versions (id, entry_id, owner_id, session_id, event_id, version, supersedes_version,
               state, sequence, occurred_at, occurred_at_ms, local_date, raw_text, entry_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              crypto.randomUUID(),
              args.entry_id,
              ctx.ownerId,
              session.id,
              eventId,
              latest.version + 1,
              latest.version,
              args.state,
              latest.sequence,
              latest.occurred_at,
              latest.occurred_at_ms,
              latest.local_date,
              args.raw_text,
              JSON.stringify(stored),
              nowMs,
            ),
          receiptStatement,
        ],
      }
    },
  )
}

// ───────────── 读工具 ─────────────
function toSession(row: SessionRow, selectionRequired: boolean) {
  return {
    session_id: row.id,
    status: row.status,
    revision: row.revision,
    started_at: row.started_at,
    ended_at: row.ended_at,
    timezone: row.timezone,
    facility: row.facility,
    selection_required: selectionRequired,
    duration_seconds: row.duration_seconds,
    duration_source: row.duration_source,
    overall_rpe: row.overall_rpe,
    calories_kcal: row.calories_kcal,
    notes: row.notes,
  }
}

export async function getWriteReceipt(
  args: { idempotency_key: string },
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const prior = await readReceipt(ctx.env.DB, ctx.ownerId, args.idempotency_key)
  if (!prior) {
    return {
      data: null,
      summary: '目前没有找到已提交的收据；若请求可能仍在途中，请稍后用同一个键再查或原样重试。',
    }
  }
  const stored = JSON.parse(prior.outcome_json) as StoredOutcome
  return { data: stored.receipt, summary: `已提交：${stored.summary}` }
}

export async function getOpenWorkoutSessions(
  args: { limit?: number; cursor?: string },
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const limit = args.limit ?? 20
  const query = await queryHash(args)
  const state: CursorState | null = args.cursor
    ? await decodeCursor(
        ctx.env,
        ctx.ownerId,
        'get_open_workout_sessions',
        query,
        args.cursor,
        ctx.deps.now(),
      )
    : null
  const all = await openSessions(ctx.env.DB, ctx.ownerId)
  const now = ctx.deps.now()
  const [afterStart, afterId] = state ? [Number(state.key[0]), String(state.key[1])] : [-1, '']
  const remaining = all.filter(
    (s) => s.started_at_ms > afterStart || (s.started_at_ms === afterStart && s.id > afterId),
  )
  const page = remaining.slice(0, limit)
  const data = page.map((s) => toSession(s, all.length > 1 || !autoEligible(s, now)))
  const last = page.at(-1)
  const nextCursor =
    remaining.length > limit && last
      ? await encodeCursor(
          ctx.env,
          ctx.ownerId,
          'get_open_workout_sessions',
          query,
          { snapshot: now, key: [last.started_at_ms, last.id] },
          now,
        )
      : null
  return {
    data,
    nextCursor,
    summary: data.length === 0 ? '没有未结束的训练会话。' : `有 ${all.length} 个未结束的训练会话。`,
  }
}

interface HistoryArgs {
  start: string
  end: string
  timezone?: string
  limit?: number
  cursor?: string
  session_id?: string
  entry_cursor?: string
  exercise_id?: string
  equipment_ref?: string
  status?: 'open' | 'finalized'
  include_superseded?: boolean
}

const HISTORY_MAX_SESSIONS = 20
const HISTORY_MAX_ENTRIES = 100

export async function getWorkoutHistory(args: HistoryArgs, ctx: ToolContext): Promise<ToolOutcome> {
  const db = ctx.env.DB
  const range = parseRange(args)
  const limit = args.limit ?? HISTORY_MAX_SESSIONS
  if (limit > HISTORY_MAX_SESSIONS) throw new KtError('INVALID_INPUT', { category: 'history_limit' })
  const now = ctx.deps.now()
  const query = await queryHash(args as unknown as Record<string, unknown>, ['cursor', 'entry_cursor'])
  const sessionState = args.cursor
    ? await decodeCursor(ctx.env, ctx.ownerId, 'get_workout_history', query, args.cursor, now)
    : null
  // 条目续页游标与会话列表参数无关：只绑定 session_id（放在 key 里）和其余筛选条件。
  const entryQuery = await queryHash(args as unknown as Record<string, unknown>, [
    'cursor',
    'entry_cursor',
    'session_id',
  ])
  let entryState: CursorState | null = null
  if (args.entry_cursor) {
    entryState = await decodeCursor(
      ctx.env,
      ctx.ownerId,
      'get_workout_history:entries',
      entryQuery,
      args.entry_cursor,
      now,
    )
    if (!args.session_id || entryState.key[0] !== args.session_id) throw new KtError('CURSOR_INVALID')
  }
  const asOf = entryState?.snapshot ?? sessionState?.snapshot ?? now
  const [afterStart, afterId] = sessionState
    ? [Number(sessionState.key[0]), String(sessionState.key[1])]
    : [-1, '']

  const sessions = await db
    .prepare(
      `SELECT * FROM workout_sessions WHERE owner_id = ?1 AND started_at_ms >= ?2 AND started_at_ms < ?3 AND created_at <= ?4
       ${args.session_id ? 'AND id = ?5' : 'AND ?5 IS NULL'} ${args.status ? 'AND status = ?6' : 'AND ?6 IS NULL'}
       AND (started_at_ms, id) > (?7, ?8) ORDER BY started_at_ms, id LIMIT ?9`,
    )
    .bind(
      ctx.ownerId,
      range.startMs,
      range.endMs,
      asOf,
      args.session_id ?? null,
      args.status ?? null,
      afterStart,
      afterId,
      limit + 1,
    )
    .all<SessionRow>()

  const open = await openSessions(db, ctx.ownerId)
  const workouts = []
  let entryBudget = HISTORY_MAX_ENTRIES
  let bytesUsed = 0
  let lastSession: SessionRow | null = null
  const pageSessions = sessions.results.slice(0, limit)
  let more = sessions.results.length > limit
  for (const [index, session] of pageSessions.entries()) {
    if (entryBudget <= 0 || bytesUsed >= PAGE_BYTE_BUDGET) {
      more = true
      break
    }
    const [afterSeq, afterVersion] = entryState
      ? [Number(entryState.key[1]), Number(entryState.key[2])]
      : [-1, -1]
    const rows = await db
      .prepare(
        `SELECT ev.* FROM workout_entry_versions ev WHERE ev.session_id = ?1 AND ev.owner_id = ?2 AND ev.created_at <= ?3
         ${
           args.include_superseded
             ? ''
             : `AND ev.state = 'active' AND ev.version = (SELECT MAX(x.version) FROM workout_entry_versions x
                WHERE x.entry_id = ev.entry_id AND x.created_at <= ?3)`
}
         AND (ev.sequence, ev.version) > (?4, ?5) ORDER BY ev.sequence, ev.version`,
      )
      .bind(session.id, ctx.ownerId, asOf, afterSeq, afterVersion)
      .all<EntryVersionRow>()
    const matching = rows.results.filter((row) => {
      const entry = JSON.parse(row.entry_json) as StoredEntry
      return (
        (!args.exercise_id || entry.exercise_id === args.exercise_id) &&
        (!args.equipment_ref || entry.equipment_ref === args.equipment_ref)
      )
    })
    if ((args.exercise_id || args.equipment_ref) && matching.length === 0) {
      // 被筛掉的会话也要推进游标，否则一页里全不匹配时会返回空列表且没有下一页。
      lastSession = session
      continue
    }
    // 条目数与字节双重预算：会话对象（notes 可达 4096 字）与每条 raw_text 都计入，避免整页超过响应上限。
    const sessionView = toSession(
      session,
      session.status === 'open' && (open.length > 1 || !autoEligible(session, now)),
    )
    const sessionSize = byteLength(JSON.stringify(sessionView)) + 2048 // 另留 entry_cursor 与外壳的余量
    if (workouts.length > 0 && bytesUsed + sessionSize > PAGE_BYTE_BUDGET) {
      more = true
      break
    }
    bytesUsed += sessionSize
    const page: EntryVersionRow[] = []
    const items = []
    for (const row of matching) {
      if (page.length >= entryBudget) break
      const item = {
        entry_id: row.entry_id,
        version: row.version,
        supersedes_version: row.supersedes_version,
        state: row.state,
        occurred_at: row.occurred_at,
        raw_text: row.raw_text,
        entry: JSON.parse(row.entry_json) as StoredEntry,
      }
      const size = byteLength(JSON.stringify(item))
      if (bytesUsed + size > PAGE_BYTE_BUDGET && (page.length > 0 || workouts.length > 0)) break
      page.push(row)
      items.push(item)
      bytesUsed += size
    }
    if (page.length === 0 && matching.length > 0) {
      // 本页预算已用完：从这个会话开始下一页。
      more = true
      break
    }
    entryBudget -= page.length
    lastSession = session
    const complete = page.length === matching.length
    const lastEntry = page.at(-1)
    const entryCursor =
      !complete && lastEntry
        ? await encodeCursor(
            ctx.env,
            ctx.ownerId,
            'get_workout_history:entries',
            entryQuery,
            { snapshot: asOf, key: [session.id, lastEntry.sequence, lastEntry.version] },
            now,
          )
        : null
    workouts.push({
      session: sessionView,
      entries: items,
      entries_complete: complete,
      entry_cursor: entryCursor,
    })
    if (!complete) {
      // 该会话剩余条目用 entry_cursor 续读；会话列表从下一个会话继续。
      more = more || index < pageSessions.length - 1
      break
    }
  }
  const nextCursor =
    more && lastSession
      ? await encodeCursor(
          ctx.env,
          ctx.ownerId,
          'get_workout_history',
          query,
          { snapshot: asOf, key: [lastSession.started_at_ms, lastSession.id] },
          now,
        )
      : null
  const entryCount = workouts.reduce((n, w) => n + w.entries.length, 0)
  return {
    data: workouts,
    nextCursor,
    summary: `返回 ${workouts.length} 个训练会话、${entryCount} 条动作记录${nextCursor ? '，还有下一页' : ''}。`,
  }
}
