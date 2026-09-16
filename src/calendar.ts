// 手机日历界面的数据源：按请求时区的自然日返回训练与体测。
// 鉴权复用 Health Connect 推送令牌（同一台手机、同一个密钥）；只读已发布快照（VISIBLE），不触发任何同步。
// 输出过 findSecretPath，与 MCP 只读工具同一条底线；日志只经 logEvent。

import type { Deps } from './mcp'
import { readSnapshot, toSummary, type VersionRow, VISIBLE } from './queries'
import { consumeRateLimit } from './ratelimit'
import { findSecretPath } from './sanitize'
import {
  constantTimeEqual,
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  KtError,
  localDate,
  logEvent,
  sha256Hex,
  zonedMidnight,
} from './util'

export const CALENDAR_PATH = '/app/calendar'
const RATE_LIMIT_PER_IP_PER_MINUTE = 60
// 全局上限：令牌泄漏时换 IP 也不能无限拉取。正常使用翻一个月只有一个请求。
const RATE_LIMIT_GLOBAL_PER_MINUTE = 120
const MAX_DAYS = 62
// 上限按 62 天窗口取整：命中说明这一窗口内容超出日历能展示的量，用 truncated 明说，不静默丢弃。
const MAX_SESSIONS = 200
const MAX_ENTRIES = 600
const MAX_MEASUREMENTS = 400
const DAY_MS = 86_400_000

const DATE = /^\d{4}-\d{2}-\d{2}$/

interface SessionRow {
  id: string
  status: 'open' | 'finalized'
  started_at: string
  started_at_ms: number
  ended_at: string | null
  timezone: string
  facility: string | null
  duration_seconds: number | null
  overall_rpe: number | null
  calories_kcal: number | null
  notes: string | null
}

interface EntryRow {
  session_id: string
  entry_json: string
}

interface StoredEntry {
  exercise_name_raw: string
  category: string
  equipment_label?: string
  sets: Record<string, unknown>[]
  notes?: string
}

/** 只给界面用得上的字段：逐组原值、动作名、器械、备注。normalized_sets 是统计口径，日历不展示。 */
interface EntryView {
  exercise_name_raw: string
  category: string
  equipment_label: string | null
  sets: Record<string, unknown>[]
  notes: string | null
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })

/** 日期串加一个自然日（按日历算，不受时区影响）。 */
function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return localDate(Date.UTC(y, m - 1, d) + DAY_MS, 'UTC')
}

const realDate = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return localDate(Date.UTC(y, m - 1, d), 'UTC') === date
}

interface Window {
  from: string
  to: string
  timezone: string
  startMs: number
  endMs: number
}

/** from/to 为含首含尾的自然日；返回 [起, 止) 的 UTC 毫秒边界。 */
function parseWindow(url: URL): Window | null {
  const from = url.searchParams.get('from') ?? ''
  const to = url.searchParams.get('to') ?? ''
  const timezone = url.searchParams.get('tz') || DEFAULT_TIMEZONE
  if (!DATE.test(from) || !DATE.test(to) || !realDate(from) || !realDate(to)) return null
  if (!isValidTimeZone(timezone) || from > to) return null
  const startMs = zonedMidnight(from, timezone)
  const endMs = zonedMidnight(nextDay(to), timezone)
  // 含首含尾 MAX_DAYS 天；多给两小时容纳夏令时那天的偏移。
  if (endMs - startMs > MAX_DAYS * DAY_MS + 2 * 3600_000) return null
  return { from, to, timezone, startMs, endMs }
}

export async function handleCalendar(request: Request, env: Env, deps: Deps): Promise<Response> {
  const expected = env.HC_INGEST_TOKEN_SHA256?.trim().toLowerCase()
  // 未配置令牌或方法不对时与不存在的路径表现一致。
  if (request.method !== 'GET' || !expected) return new Response('Not found', { status: 404 })
  const started = deps.now()
  try {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    await consumeRateLimit(env.DB, `calendar:${ip}`, RATE_LIMIT_PER_IP_PER_MINUTE, 60, started)

    const header = request.headers.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!token || !constantTimeEqual(await sha256Hex(token), expected)) {
      logEvent({ event: 'calendar', status: 'unauthorized' })
      return reply(401, { error: 'unauthorized' })
    }
    // 全局计数放在鉴权之后：未授权的请求再多也挤不掉本人设备的额度。
    await consumeRateLimit(env.DB, 'calendar:all', RATE_LIMIT_GLOBAL_PER_MINUTE, 60, started)

    const range = parseWindow(new URL(request.url))
    if (!range) return reply(400, { error: 'invalid_range' })

    const body = await readCalendar(env, range, deps)
    if (findSecretPath(body)) {
      logEvent({ event: 'calendar', status: 'failed', code: 'SENSITIVE_PAYLOAD_BLOCKED' })
      return reply(500, { error: 'sensitive_payload_blocked' })
    }
    logEvent({
      event: 'calendar',
      status: 'ok',
      count: body.days.length,
      duration_ms: deps.now() - started,
    })
    return reply(200, body)
  } catch (error) {
    if (error instanceof KtError && error.code === 'RATE_LIMITED') {
      return reply(
        429,
        { error: 'rate_limited' },
        { 'retry-after': String(error.options.retryAfterSeconds ?? 60) },
      )
    }
    logEvent({
      event: 'calendar',
      status: 'failed',
      code: error instanceof KtError ? error.code : 'STORAGE_FAILED',
      category: error instanceof Error ? error.name : 'unknown',
    })
    return reply(500, { error: 'storage_failed' })
  }
}

async function readCalendar(env: Env, range: Window, deps: Deps) {
  const db = env.DB
  const ownerId = env.OWNER_ID
  const tz = range.timezone
  const snapshot = await readSnapshot(db, ownerId, deps.now())
  // 库里只应有本人；配置了 HC_PROFILE_REF 就按它过滤，避免将来多出成员时把别人的体测混进日历。
  const profile = env.HC_PROFILE_REF || null

  const sessions = await db
    .prepare(
      `SELECT id, status, started_at, started_at_ms, ended_at, timezone, facility, duration_seconds,
              overall_rpe, calories_kcal, notes
       FROM workout_sessions WHERE owner_id = ?1 AND started_at_ms >= ?2 AND started_at_ms < ?3
       ORDER BY started_at_ms, id LIMIT ?4`,
    )
    .bind(ownerId, range.startMs, range.endMs, MAX_SESSIONS + 1)
    .all<SessionRow>()
  const sessionRows = sessions.results.slice(0, MAX_SESSIONS)

  // 只取每个动作当前生效的版本：撤回或被修订的旧版本不进日历（与 get_workout_history 默认一致）。
  const entries = sessionRows.length
    ? await db
        .prepare(
          `SELECT ev.session_id, ev.entry_json FROM workout_entry_versions ev
           WHERE ev.owner_id = ?1 AND ev.session_id IN (SELECT value FROM json_each(?2)) AND ev.state = 'active'
             AND ev.version = (SELECT MAX(x.version) FROM workout_entry_versions x WHERE x.entry_id = ev.entry_id)
           ORDER BY ev.session_id, ev.sequence, ev.version LIMIT ?3`,
        )
        .bind(ownerId, JSON.stringify(sessionRows.map((s) => s.id)), MAX_ENTRIES + 1)
        .all<EntryRow>()
    : { results: [] as EntryRow[] }
  const entryRows = entries.results.slice(0, MAX_ENTRIES)

  const measurements = await db
    .prepare(
      `SELECT v.* FROM raw_record_versions v WHERE ${VISIBLE} AND v.owner_id = ?2 AND v.dataset = 'weight'
       AND v.is_deleted = 0 AND v.measured_at IS NOT NULL AND v.measured_at >= ?3 AND v.measured_at < ?4
       AND (?5 IS NULL OR v.profile_ref = ?5)
       ORDER BY v.measured_at, v.raw_record_id LIMIT ?6`,
    )
    .bind(
      snapshot.generation,
      ownerId,
      Math.ceil(range.startMs / 1000),
      Math.ceil(range.endMs / 1000),
      profile,
      MAX_MEASUREMENTS + 1,
    )
    .all<VersionRow>()
  const measurementRows = measurements.results.slice(0, MAX_MEASUREMENTS)

  const byEntrySession = new Map<string, EntryView[]>()
  for (const row of entryRows) {
    const entry = JSON.parse(row.entry_json) as StoredEntry
    const list = byEntrySession.get(row.session_id) ?? []
    list.push({
      exercise_name_raw: entry.exercise_name_raw,
      category: entry.category,
      equipment_label: entry.equipment_label ?? null,
      sets: entry.sets,
      notes: entry.notes ?? null,
    })
    byEntrySession.set(row.session_id, list)
  }

  const days = new Map<
    string,
    { date: string; calories_kcal: number | null; sessions: unknown[]; measurements: unknown[] }
  >()
  const dayOf = (date: string) => {
    const day = days.get(date) ?? { date, calories_kcal: null, sessions: [], measurements: [] }
    days.set(date, day)
    return day
  }
  for (const s of sessionRows) {
    // 训练按开始时刻所在的自然日归档；请求时区优先，与趋势口径一致。
    const day = dayOf(localDate(s.started_at_ms, tz))
    if (s.calories_kcal !== null) day.calories_kcal = (day.calories_kcal ?? 0) + s.calories_kcal
    day.sessions.push({
      status: s.status,
      started_at: s.started_at,
      ended_at: s.ended_at,
      timezone: s.timezone,
      facility: s.facility,
      duration_seconds: s.duration_seconds,
      overall_rpe: s.overall_rpe,
      calories_kcal: s.calories_kcal,
      notes: s.notes,
      entries: byEntrySession.get(s.id) ?? [],
    })
  }
  for (const row of measurementRows) {
    const summary = toSummary(row, tz)
    if (summary.local_date === null) continue
    dayOf(summary.local_date).measurements.push({
      measured_at: summary.measured_at,
      metrics: summary.metrics,
      quality_flags: summary.quality_flags,
    })
  }

  return {
    schema_version: '1' as const,
    timezone: tz,
    from: range.from,
    to: range.to,
    stale: snapshot.stale,
    synced_at: snapshot.syncedAt,
    truncated:
      sessions.results.length > MAX_SESSIONS ||
      entries.results.length > MAX_ENTRIES ||
      measurements.results.length > MAX_MEASUREMENTS,
    days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
  }
}
