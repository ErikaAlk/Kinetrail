// 可复现趋势口径（trend_v1 / training_v1）。所有日历按请求时区（默认 Asia/Shanghai）的自然日计算。

import type { ToolContext, ToolOutcome } from './mcp'
import { parseRange, type Range, readSnapshot, resolveProfile, VISIBLE } from './queries'
import { addDays, isoInZone, KtError, localDate, zonedMidnight } from './util'
import type { StoredEntry } from './workouts'

export const BODY_FORMULA_VERSION = 'trend_v1'
export const TRAINING_FORMULA_VERSION = 'training_v1'
const MAX_POINTS = 1000
const MAX_DAYS = { day: 366, week: 104 * 7, month: 60 * 31 } as const
type Interval = keyof typeof MAX_DAYS

export interface TrendPoint {
  period_start: string
  period_end: string
  group_key: string
  metric: string
  value: number | null
  unit: string
  samples: number
  valid_days: number
  missing_count: number
  quality_flags: string[]
}

// ───────────── 日历 ─────────────
export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length

const weekday = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 // 周一 = 0
}

function periodStartDate(date: string, interval: Interval): string {
  if (interval === 'week') return addDays(date, -weekday(date))
  if (interval === 'month') return `${date.slice(0, 7)}-01`
  return date
}

function nextPeriodDate(start: string, interval: Interval): string {
  if (interval === 'day') return addDays(start, 1)
  if (interval === 'week') return addDays(start, 7)
  const [y, m] = start.split('-').map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

interface Period {
  startDate: string
  endDate: string
  startMs: number
  endMs: number
  clipped: boolean
}

/** 按日历切周期（周从周一开始），与请求区间 [start,end) 求交；被截断的周期标 partial_period。 */
export function periods(range: Range, interval: Interval): Period[] {
  const out: Period[] = []
  let cursor = periodStartDate(localDate(range.startMs, range.timezone), interval)
  for (;;) {
    const next = nextPeriodDate(cursor, interval)
    const calStart = zonedMidnight(cursor, range.timezone)
    const calEnd = zonedMidnight(next, range.timezone)
    if (calStart >= range.endMs) break
    const startMs = Math.max(calStart, range.startMs)
    const endMs = Math.min(calEnd, range.endMs)
    if (startMs < endMs) {
      out.push({
        startDate: cursor,
        endDate: next,
        startMs,
        endMs,
        clipped: startMs !== calStart || endMs !== calEnd,
      })
    }
    cursor = next
  }
  return out
}

function parseTrendRange(args: { start: string; end: string; timezone?: string; interval?: Interval }) {
  const interval = args.interval ?? 'week'
  const range = parseRange(args, MAX_DAYS[interval])
  return { interval, range }
}

const point = (
  p: { startMs: number; endMs: number },
  tz: string,
  rest: Omit<TrendPoint, 'period_start' | 'period_end'>,
) => ({
  period_start: isoInZone(p.startMs, tz),
  period_end: isoInZone(p.endMs, tz),
  ...rest,
})

// ───────────── 体测趋势 ─────────────
export const BODY_METRICS = ['weight_kg', 'body_fat_pct', 'fat_mass_kg', 'fat_free_mass_kg'] as const
type BodyMetric = (typeof BODY_METRICS)[number]
const BODY_UNITS: Record<BodyMetric, string> = {
  weight_kg: 'kg',
  body_fat_pct: '%',
  fat_mass_kg: 'kg',
  fat_free_mass_kg: 'kg',
}

export interface BodySample {
  measuredMs: number
  weightKg: number | null
  bodyFatPct: number | null
}

/** 单次测量先算派生值（fat_mass = weight × bfr / 100），缺 bfr 或 bfr≤0 不算、不以 0 填补。 */
function sampleValue(sample: BodySample, metric: BodyMetric): number | null {
  const { weightKg: w, bodyFatPct: f } = sample
  if (metric === 'weight_kg') return w
  if (metric === 'body_fat_pct') return f
  if (w === null || f === null || f <= 0) return null
  const fat = (w * f) / 100
  return metric === 'fat_mass_kg' ? fat : w - fat
}

export function computeBodyTrend(
  samples: BodySample[],
  range: Range,
  interval: Interval,
  metrics: readonly BodyMetric[],
): TrendPoint[] {
  const tz = range.timezone
  // 窗口 [from,to) 内：先按自然日取中位数，再对有数据的日等权平均；缺该指标的测量计入 missing。
  const windowStats = (metric: BodyMetric, fromMs: number, toMs: number) => {
    const byDay = new Map<string, number[]>()
    let missing = 0
    let count = 0
    for (const s of samples) {
      if (s.measuredMs < fromMs || s.measuredMs >= toMs) continue
      const v = sampleValue(s, metric)
      if (v === null) {
        missing++
        continue
      }
      const day = localDate(s.measuredMs, tz)
      byDay.set(day, [...(byDay.get(day) ?? []), v])
      count++
    }
    const medians = [...byDay.values()].map(median)
    return { value: medians.length ? mean(medians) : null, days: medians.length, samples: count, missing }
  }

  const out: TrendPoint[] = []
  for (const period of periods(range, interval)) {
    for (const metric of metrics) {
      const unit = BODY_UNITS[metric]
      const flags = period.clipped ? ['partial_period'] : []
      const current = windowStats(metric, period.startMs, period.endMs)
      if (current.days === 0) flags.push('no_data')
      out.push(
        point(period, tz, {
          group_key: 'period',
          metric,
          value: current.value,
          unit,
          samples: current.samples,
          valid_days: current.days,
          missing_count: current.missing,
          quality_flags: flags,
        }),
      )
      if (interval === 'day') {
        // 7 日均线：最近 7 个日历日（含当日）中有数据日的均值，不是最近 7 次测量。
        const from = zonedMidnight(addDays(period.startDate, -6), tz)
        const ma = windowStats(metric, from, period.endMs)
        out.push(
          point(period, tz, {
            group_key: 'ma7',
            metric,
            value: ma.value,
            unit,
            samples: ma.samples,
            valid_days: ma.days,
            missing_count: ma.missing,
            quality_flags: ma.days < 4 ? ['sparse_window'] : [],
          }),
        )
      } else {
        // 环比：与上一个完整日历周期的等权日均值比较。
        const prevStartDate =
          interval === 'week'
            ? addDays(period.startDate, -7)
            : periodStartDate(addDays(period.startDate, -1), 'month')
        const prev = windowStats(
          metric,
          zonedMidnight(prevStartDate, tz),
          zonedMidnight(period.startDate, tz),
        )
        const change = current.value !== null && prev.value !== null ? current.value - prev.value : null
        const pct =
          change !== null && prev.value !== null && prev.value !== 0 ? (change / prev.value) * 100 : null
        const base = {
          samples: current.samples,
          valid_days: current.days,
          missing_count: current.missing,
          quality_flags: [
            ...flags,
            `previous_valid_days:${prev.days}`,
            ...(prev.value === 0 ? ['previous_zero'] : []),
          ],
        }
        out.push(point(period, tz, { ...base, group_key: 'pop_change', metric, value: change, unit }))
        out.push(point(period, tz, { ...base, group_key: 'pop_change_pct', metric, value: pct, unit: '%' }))
      }
    }
  }
  return out
}

async function bodySamples(ctx: ToolContext, fromMs: number, toMs: number, profileRef?: string) {
  const db = ctx.env.DB
  const snap = await readSnapshot(db, ctx.ownerId, ctx.deps.now())
  const profile = await resolveProfile(db, ctx.ownerId, profileRef)
  const rows = await db
    .prepare(
      `SELECT v.measured_at, v.metrics_json FROM raw_record_versions v WHERE ${VISIBLE} AND v.owner_id = ?2
       AND v.dataset = 'weight' AND v.is_deleted = 0 AND v.measured_at >= ?3 AND v.measured_at < ?4
       ${profile ? 'AND v.profile_ref = ?5' : 'AND ?5 IS NULL'}`,
    )
    .bind(snap.generation, ctx.ownerId, Math.floor(fromMs / 1000), Math.ceil(toMs / 1000), profile)
    .all<{ measured_at: number; metrics_json: string }>()
  const samples: BodySample[] = rows.results
    .map((r) => {
      const m = JSON.parse(r.metrics_json) as Record<string, number | null>
      return {
        measuredMs: r.measured_at * 1000,
        weightKg: m.weight_kg ?? null,
        bodyFatPct: m.body_fat_pct ?? null,
      }
    })
    .filter((s) => s.measuredMs >= fromMs && s.measuredMs < toMs)
  return { snap, samples }
}

const lookbackStart = (range: Range, interval: Interval) => {
  const first = periodStartDate(localDate(range.startMs, range.timezone), interval)
  const back =
    interval === 'day'
      ? addDays(first, -6)
      : interval === 'week'
        ? addDays(first, -7)
        : periodStartDate(addDays(first, -1), 'month')
  return Math.min(range.startMs, zonedMidnight(back, range.timezone))
}

function assertPointBudget(count: number) {
  if (count > MAX_POINTS) throw new KtError('INVALID_RANGE', { category: 'too_many_points' })
}

interface BodyTrendArgs {
  start: string
  end: string
  timezone?: string
  interval?: Interval
  profile_ref?: string
  metrics?: BodyMetric[]
  cursor?: string
}

export async function getTrend(args: BodyTrendArgs, ctx: ToolContext): Promise<ToolOutcome> {
  if (args.cursor) throw new KtError('CURSOR_INVALID')
  const { interval, range } = parseTrendRange(args)
  const metrics = args.metrics ?? BODY_METRICS
  assertPointBudget(periods(range, interval).length * metrics.length * (interval === 'day' ? 2 : 3))
  const { snap, samples } = await bodySamples(
    ctx,
    lookbackStart(range, interval),
    range.endMs,
    args.profile_ref,
  )
  const points = computeBodyTrend(samples, range, interval, metrics)
  return {
    data: {
      start: isoInZone(range.startMs, range.timezone),
      end: isoInZone(range.endMs, range.timezone),
      interval,
      timezone: range.timezone,
      formula_version: BODY_FORMULA_VERSION,
      points,
    },
    stale: snap.stale,
    syncedAt: snap.syncedAt,
    summary: `体测趋势 ${points.length} 个点（${interval}，${range.timezone}）。观察结果，不作因果或医疗判断。`,
  }
}

// ───────────── 训练趋势 ─────────────
export interface TrainingEntry {
  sessionId: string
  sessionOpen: boolean
  sessionFacility: string | null
  occurredMs: number
  entry: StoredEntry
}

const normalizeName = (text: string) => text.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')

/** 力量序列键：动作 + 场馆 + 器械 + 负重口径。器械未知时附会话 ID，绝不把未知器械合并成同一条曲线。 */
export function seriesKey(item: TrainingEntry, basis: string): { key: string; flags: string[] } {
  const e = item.entry
  const exercise = e.exercise_id ?? normalizeName(e.exercise_name_raw)
  const facility = e.facility ?? item.sessionFacility ?? 'unknown_facility'
  const equipmentKnown = e.equipment_ref ?? (e.equipment_label ? normalizeName(e.equipment_label) : null)
  const equipment = equipmentKnown ?? `unknown_equipment@${item.sessionId}`
  const flags = equipmentKnown ? [] : ['equipment_unknown_not_comparable']
  const key = `series:${exercise}|${facility}|${equipment}|${basis}`
  return { key: key.length <= 128 ? key : `series:${key.length}:${key.slice(0, 100)}`, flags }
}

const epley = (kg: number, reps: number) =>
  reps === 1 ? kg : reps >= 2 && reps <= 10 ? kg * (1 + reps / 30) : null

export function computeTrainingTrend(
  items: TrainingEntry[],
  range: Range,
  interval: Interval,
  includeSeries: boolean,
): TrendPoint[] {
  const tz = range.timezone
  const out: TrendPoint[] = []
  for (const period of periods(range, interval)) {
    const inPeriod = items.filter((i) => i.occurredMs >= period.startMs && i.occurredMs < period.endMs)
    const base = period.clipped ? ['partial_period'] : []
    const days = new Set(inPeriod.map((i) => localDate(i.occurredMs, tz)))
    const sessions = new Set(inPeriod.map((i) => i.sessionId))
    const provisional = inPeriod.some((i) => i.sessionOpen) ? ['provisional_session'] : []

    let workingSets = 0
    let warmupSets = 0
    let volume = 0
    let volumeSets = 0
    let volumeMissing = 0
    let cardioSeconds = 0
    let cardioSegments = 0
    let cardioDistance = 0
    let distanceMissing = 0
    const volumeDays = new Set<string>()
    const cardioDays = new Set<string>()
    const series = new Map<
      string,
      {
        flags: Set<string>
        volume: number
        sets: number
        best: number | null
        e1rm: number | null
        days: Set<string>
        missing: number
      }
    >()

    for (const item of inPeriod) {
      const day = localDate(item.occurredMs, tz)
      const e = item.entry
      e.sets.forEach((set, index) => {
        const norm = e.normalized_sets[index]
        if (e.category === 'cardio') {
          if (set.duration_seconds !== undefined) {
            cardioSeconds += set.duration_seconds
            cardioSegments++
            cardioDays.add(day)
          }
          if (norm?.distance_m != null) cardioDistance += norm.distance_m
          else if (set.distance_value !== undefined || set.distance_original) distanceMissing++
          return
        }
        if (e.category !== 'strength') return
        if (set.set_type === 'warmup') {
          warmupSets++
          return
        }
        workingSets++
        const basis = set.load_basis ?? 'unspecified'
        const kg = norm?.load_kg ?? null
        const reps = set.reps ?? null
        const externalLoad = basis === 'unspecified' || basis === 'total_external'
        const { key, flags } = seriesKey(item, basis)
        const s = series.get(key) ?? {
          flags: new Set<string>(),
          volume: 0,
          sets: 0,
          best: null,
          e1rm: null,
          days: new Set<string>(),
          missing: 0,
        }
        for (const f of flags) s.flags.add(f)
        s.sets++
        s.days.add(day)
        if (kg !== null && reps !== null && reps > 0 && basis !== 'bodyweight' && basis !== 'assisted') {
          s.volume += kg * reps
          s.best = Math.max(s.best ?? kg, kg)
          const est = epley(kg, reps)
          if (est !== null) s.e1rm = Math.max(s.e1rm ?? est, est)
          if (externalLoad) {
            volume += kg * reps
            volumeSets++
            volumeDays.add(day)
          }
        } else {
          s.missing++
          if (externalLoad) volumeMissing++
        }
        series.set(key, s)
      })
    }

    const add = (
      group: string,
      metric: string,
      value: number | null,
      unit: string,
      samples: number,
      validDays: number,
      missing: number,
      flags: string[] = [],
    ) =>
      out.push(
        point(period, tz, {
          group_key: group,
          metric,
          value,
          unit,
          samples,
          valid_days: validDays,
          missing_count: missing,
          quality_flags: [...base, ...flags],
        }),
      )
    add('all', 'sessions', sessions.size, 'count', inPeriod.length, days.size, 0, provisional)
    add('all', 'training_days', days.size, 'day', inPeriod.length, days.size, 0, provisional)
    add('all', 'working_sets', workingSets, 'set', workingSets, days.size, 0, provisional)
    add('all', 'warmup_sets', warmupSets, 'set', warmupSets, days.size, 0, provisional)
    add('all', 'volume_kg', volumeSets ? volume : null, 'kg', volumeSets, volumeDays.size, volumeMissing, [
      'external_load_only',
      ...provisional,
    ])
    add(
      'all',
      'cardio_duration_seconds',
      cardioSegments ? cardioSeconds : null,
      's',
      cardioSegments,
      cardioDays.size,
      0,
      provisional,
    )
    add(
      'all',
      'cardio_distance_m',
      cardioDistance || null,
      'm',
      cardioSegments,
      cardioDays.size,
      distanceMissing,
      provisional,
    )
    if (includeSeries) {
      for (const [key, s] of [...series].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const flags = [...s.flags]
        add(key, 'volume_kg', s.best === null ? null : s.volume, 'kg', s.sets, s.days.size, s.missing, flags)
        add(key, 'working_sets', s.sets, 'set', s.sets, s.days.size, 0, flags)
        add(key, 'best_load_kg', s.best, 'kg', s.sets, s.days.size, s.missing, flags)
        add(key, 'e1rm_epley_kg', s.e1rm, 'kg', s.sets, s.days.size, s.missing, [
          'estimate',
          'epley_v1',
          ...flags,
        ])
      }
    }
  }
  return out
}

async function trainingItems(
  ctx: ToolContext,
  range: Range,
  filters: { exercise_id?: string; equipment_ref?: string },
) {
  const rows = await ctx.env.DB.prepare(
    `SELECT ev.session_id, ev.occurred_at_ms, ev.entry_json, s.status, s.facility FROM workout_entry_versions ev
     JOIN workout_sessions s ON s.id = ev.session_id
     WHERE ev.owner_id = ?1 AND ev.occurred_at_ms >= ?2 AND ev.occurred_at_ms < ?3 AND ev.state = 'active'
     AND ev.version = (SELECT MAX(x.version) FROM workout_entry_versions x WHERE x.entry_id = ev.entry_id)`,
  )
    .bind(ctx.ownerId, range.startMs, range.endMs)
    .all<{
      session_id: string
      occurred_at_ms: number
      entry_json: string
      status: string
      facility: string | null
    }>()
  return rows.results
    .map((r) => ({
      sessionId: r.session_id,
      sessionOpen: r.status === 'open',
      sessionFacility: r.facility,
      occurredMs: r.occurred_at_ms,
      entry: JSON.parse(r.entry_json) as StoredEntry,
    }))
    .filter(
      (i) =>
        (!filters.exercise_id || i.entry.exercise_id === filters.exercise_id) &&
        (!filters.equipment_ref || i.entry.equipment_ref === filters.equipment_ref),
    )
}

interface TrainingTrendArgs {
  start: string
  end: string
  timezone?: string
  interval?: Interval
  exercise_id?: string
  equipment_ref?: string
  cursor?: string
}

export async function getTrainingTrend(args: TrainingTrendArgs, ctx: ToolContext): Promise<ToolOutcome> {
  if (args.cursor) throw new KtError('CURSOR_INVALID')
  const { interval, range } = parseTrendRange(args)
  const items = await trainingItems(ctx, range, args)
  const points = computeTrainingTrend(items, range, interval, true)
  assertPointBudget(points.length)
  return {
    data: {
      start: isoInZone(range.startMs, range.timezone),
      end: isoInZone(range.endMs, range.timezone),
      interval,
      timezone: range.timezone,
      formula_version: TRAINING_FORMULA_VERSION,
      points,
    },
    summary: `训练趋势 ${points.length} 个点（${interval}）。e1RM 为 Epley 估算值。`,
  }
}

export async function getProgressOverview(
  args: {
    start: string
    end: string
    timezone?: string
    interval?: Interval
    profile_ref?: string
    cursor?: string
  },
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (args.cursor) throw new KtError('CURSOR_INVALID')
  const { interval, range } = parseTrendRange(args)
  const count = periods(range, interval).length
  assertPointBudget(count * (BODY_METRICS.length * (interval === 'day' ? 2 : 3) + 7))
  const { snap, samples } = await bodySamples(
    ctx,
    lookbackStart(range, interval),
    range.endMs,
    args.profile_ref,
  )
  const items = await trainingItems(ctx, range, {})
  const frame = {
    start: isoInZone(range.startMs, range.timezone),
    end: isoInZone(range.endMs, range.timezone),
    interval,
    timezone: range.timezone,
  }
  return {
    data: {
      body: {
        ...frame,
        formula_version: BODY_FORMULA_VERSION,
        points: computeBodyTrend(samples, range, interval, BODY_METRICS),
      },
      training: {
        ...frame,
        formula_version: TRAINING_FORMULA_VERSION,
        points: computeTrainingTrend(items, range, interval, false),
      },
    },
    stale: snap.stale,
    syncedAt: snap.syncedAt,
    summary: '体测与训练同期并列结果，仅为观察，不代表因果。',
  }
}
