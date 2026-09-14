import { describe, expect, it } from 'vitest'
import { parseRange } from '../src/queries'
import {
  type BodySample,
  computeBodyTrend,
  computeTrainingTrend,
  median,
  periods,
  type TrainingEntry,
} from '../src/trends'
import { normalizeEntry } from '../src/workouts'
import { clock, deps, syncBody, syntheticSecrets, toolContext, upstream, weight } from './fitdays-mock'
import type { Loose } from './helpers'

const sample = (iso: string, weightKg: number | null, bodyFatPct: number | null): BodySample => ({
  measuredMs: Date.parse(iso),
  weightKg,
  bodyFatPct,
})
const find = (points: Loose[], group: string, metric: string, start?: string) =>
  points.find(
    (p) => p.group_key === group && p.metric === metric && (!start || p.period_start.startsWith(start)),
  )

describe('体测趋势口径 trend_v1（固定数字）', () => {
  // 两条落在 09-14 23:30/23:45（+08:00），一条在 09-15 00:30：UTC 同一天，上海是两天。
  const midnight = [
    sample('2026-09-14T16:30:00Z', 70, 20),
    sample('2026-09-14T15:30:00Z', 72, 25),
    sample('2026-09-14T15:45:00Z', 74, 30),
  ]

  it('上海自然日分组、先日中位数再等权、脂肪量逐次先算', () => {
    const range = parseRange({ start: '2026-09-14T00:00:00+08:00', end: '2026-09-21T00:00:00+08:00' })
    const points = computeBodyTrend(midnight, range, 'week', ['weight_kg', 'fat_mass_kg', 'fat_free_mass_kg'])
    const w = find(points, 'period', 'weight_kg')
    expect(w.value).toBe(71.5) // (median(72,74)=73 + 70) / 2，不是三次测量均值 72
    expect(w.valid_days).toBe(2)
    expect(w.samples).toBe(3)
    expect(w.period_start).toBe('2026-09-14T00:00:00+08:00')
    expect(find(points, 'period', 'fat_mass_kg').value).toBeCloseTo(17.05, 10)
    expect(find(points, 'period', 'fat_free_mass_kg').value).toBeCloseTo(54.45, 10)
  })

  it('日聚合用中位数（多称几次或一次异常值不拉偏当天）', () => {
    const range = parseRange({ start: '2026-09-14T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00' })
    const points = computeBodyTrend(
      [
        sample('2026-09-14T01:00:00Z', 70, 20),
        sample('2026-09-14T02:00:00Z', 71, 20),
        sample('2026-09-14T03:00:00Z', 80, 20),
      ],
      range,
      'day',
      ['weight_kg'],
    )
    expect(find(points, 'period', 'weight_kg').value).toBe(71)
  })

  it('缺 bfr 不算脂肪量且不按 0 填补；bfr=0 不参与派生', () => {
    const range = parseRange({ start: '2026-09-14T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00' })
    const points = computeBodyTrend(
      [sample('2026-09-14T01:00:00Z', 70, null), sample('2026-09-14T02:00:00Z', 71, 0)],
      range,
      'day',
      ['weight_kg', 'fat_mass_kg'],
    )
    const fat = find(points, 'period', 'fat_mass_kg')
    expect(fat.value).toBeNull()
    expect(fat.missing_count).toBe(2)
    expect(find(points, 'period', 'weight_kg').value).toBe(70.5)
  })

  it('7 日均线按日历日（不是最近 7 次），周环比用上一个完整周，上期为 0 时百分比为 null', () => {
    const data = [
      sample('2026-09-08T02:00:00Z', 80, 0), // 上周二
      sample('2026-09-08T03:00:00Z', 82, 0), // 同日第二次：日中位数 81
      ...midnight,
    ]
    const days = computeBodyTrend(
      data,
      parseRange({ start: '2026-09-14T00:00:00+08:00', end: '2026-09-16T00:00:00+08:00' }),
      'day',
      ['weight_kg'],
    )
    const ma14 = find(days, 'ma7', 'weight_kg', '2026-09-14')
    expect(ma14.value).toBe(77) // mean(81, 73)
    expect(ma14.valid_days).toBe(2)
    expect(ma14.quality_flags).toContain('sparse_window')
    expect(find(days, 'ma7', 'weight_kg', '2026-09-15').value).toBe(71.5) // 09-09..09-15：mean(73, 70)

    const weeks = computeBodyTrend(
      data,
      parseRange({ start: '2026-09-14T00:00:00+08:00', end: '2026-09-21T00:00:00+08:00' }),
      'week',
      ['weight_kg', 'body_fat_pct'],
    )
    expect(find(weeks, 'pop_change', 'weight_kg').value).toBe(-9.5) // 71.5 - 81
    expect(find(weeks, 'pop_change_pct', 'weight_kg').value).toBeCloseTo((-9.5 / 81) * 100, 10)
    // bfr=0（仅称重）不计入体脂率：上一周没有有效体脂数据，环比为 null
    const pct = find(weeks, 'pop_change_pct', 'body_fat_pct')
    expect(pct.value).toBeNull()
    expect(pct.quality_flags).toContain('previous_valid_days:0')
    expect(find(weeks, 'period', 'body_fat_pct').value).toBe(23.75) // mean(median(25,30), 20)

    const zeroPrev = computeBodyTrend(
      [sample('2026-09-08T02:00:00Z', 0, 20), ...midnight],
      parseRange({ start: '2026-09-14T00:00:00+08:00', end: '2026-09-21T00:00:00+08:00' }),
      'week',
      ['weight_kg'],
    )
    const zeroPct = find(zeroPrev, 'pop_change_pct', 'weight_kg')
    expect(zeroPct.value).toBeNull()
    expect(zeroPct.quality_flags).toContain('previous_zero')
  })

  it('周从周一开始；被区间截断的周期标 partial_period；月份按日历月', () => {
    const range = parseRange({ start: '2026-09-16T12:00:00+08:00', end: '2026-10-02T00:00:00+08:00' })
    const weekly = periods(range, 'week')
    expect(weekly.map((p) => p.startDate)).toEqual(['2026-09-14', '2026-09-21', '2026-09-28'])
    expect(weekly.map((p) => p.clipped)).toEqual([true, false, true])
    expect(periods(range, 'month').map((p) => p.startDate)).toEqual(['2026-09-01', '2026-10-01'])
    expect(median([3, 1, 2, 10])).toBe(2.5)
  })
})

describe('训练趋势口径 training_v1（固定数字）', () => {
  const entry = (
    sessionId: string,
    iso: string,
    e: Parameters<typeof normalizeEntry>[0],
    open = false,
  ): TrainingEntry => ({
    sessionId,
    sessionOpen: open,
    sessionFacility: '健身房',
    occurredMs: Date.parse(iso),
    entry: normalizeEntry(e),
  })
  const items = [
    entry('s1', '2026-09-14T10:00:00Z', {
      exercise_name_raw: '高位下拉',
      category: 'strength',
      equipment_label: '器械A',
      sets: [
        { load_value: 20, load_unit: 'kg', reps: 10, set_type: 'warmup' },
        { load_value: 45, load_unit: 'kg', reps: 12 },
        { load_value: 45, load_unit: 'kg', reps: 12 },
        { load_value: 45, load_unit: 'kg', reps: 10 },
      ],
    }),
    entry('s1', '2026-09-14T10:20:00Z', {
      exercise_name_raw: '高位下拉',
      category: 'strength',
      equipment_label: '器械B',
      sets: [{ load_value: 100, load_unit: 'lb', reps: 5 }],
    }),
    entry('s1', '2026-09-14T10:40:00Z', {
      exercise_name_raw: '跑步机',
      category: 'cardio',
      sets: [{ duration_seconds: 1200, distance_value: 3, distance_unit: 'km' }],
    }),
    entry(
      's2',
      '2026-09-16T10:00:00Z',
      { exercise_name_raw: '引体', category: 'strength', sets: [{ reps: 8, load_basis: 'bodyweight' }] },
      true,
    ),
    entry('s3', '2026-09-17T10:00:00Z', {
      exercise_name_raw: '卧推',
      category: 'strength',
      sets: [{ load_value: 60, load_unit: 'kg', reps: 5 }],
    }),
    entry('s4', '2026-09-18T10:00:00Z', {
      exercise_name_raw: '卧推',
      category: 'strength',
      sets: [{ load_value: 62.5, load_unit: 'kg', reps: 5 }],
    }),
  ]
  const range = parseRange({ start: '2026-09-14T00:00:00+08:00', end: '2026-09-21T00:00:00+08:00' })
  const points = computeTrainingTrend(items, range, 'week', true)

  it('频率、有效训练日、组数、外部负重训练量', () => {
    expect(find(points, 'all', 'sessions').value).toBe(4)
    expect(find(points, 'all', 'sessions').quality_flags).toContain('provisional_session')
    expect(find(points, 'all', 'training_days').value).toBe(4)
    expect(find(points, 'all', 'working_sets').value).toBe(7)
    expect(find(points, 'all', 'warmup_sets').value).toBe(1)
    // 45×34 + 100lb×5 + 60×5 + 62.5×5；热身与自重不计
    expect(find(points, 'all', 'volume_kg').value).toBeCloseTo(1530 + 100 * 0.45359237 * 5 + 300 + 312.5, 9)
    expect(find(points, 'all', 'cardio_duration_seconds').value).toBe(1200)
    expect(find(points, 'all', 'cardio_distance_m').value).toBe(3000)
  })

  it('不同器械分开成序列；Epley 只用 2–10 次；器械未知时按会话隔离，不合并成一条曲线', () => {
    const a = find(points, 'series:高位下拉|健身房|器械a|unspecified', 'e1rm_epley_kg')
    expect(a.value).toBe(60) // 12 次不估算，10 次：45×(1+10/30)
    expect(a.quality_flags).toEqual(expect.arrayContaining(['estimate', 'epley_v1']))
    expect(find(points, 'series:高位下拉|健身房|器械a|unspecified', 'volume_kg').value).toBe(1530)
    expect(find(points, 'series:高位下拉|健身房|器械b|unspecified', 'best_load_kg').value).toBeCloseTo(
      45.359237,
      9,
    )
    const bench = points.filter((p) => p.metric === 'best_load_kg' && p.group_key.startsWith('series:卧推'))
    expect(bench.map((p) => p.value).sort()).toEqual([60, 62.5])
    expect(bench.every((p) => p.quality_flags.includes('equipment_unknown_not_comparable'))).toBe(true)
  })
})

describe('审查回归：超长序列键', () => {
  it('动作名与场馆很长时仍按器械区分序列，不因截断合并', () => {
    const longName = '坐姿器械辅助单臂高位下拉变式'.repeat(5) // 70 字
    const facility = '某某市某某区某某路某某号某某大厦某某层某某健身中心'.repeat(2)
    const make = (sessionId: string, equipment: string | undefined, iso: string): TrainingEntry => ({
      sessionId,
      sessionOpen: false,
      sessionFacility: facility,
      occurredMs: Date.parse(iso),
      entry: normalizeEntry({
        exercise_name_raw: longName,
        category: 'strength',
        ...(equipment ? { equipment_label: equipment } : {}),
        sets: [{ load_value: 40, load_unit: 'kg', reps: 10 }],
      }),
    })
    const points = computeTrainingTrend(
      [
        make('s1', '器械X', '2026-09-14T10:00:00Z'),
        make('s1', '器械Y', '2026-09-14T10:10:00Z'),
        make('s2', undefined, '2026-09-15T10:00:00Z'),
        make('s3', undefined, '2026-09-16T10:00:00Z'),
      ],
      parseRange({ start: '2026-09-14T00:00:00+08:00', end: '2026-09-21T00:00:00+08:00' }),
      'week',
      true,
    )
    const sets = points.filter((p) => p.metric === 'working_sets' && p.group_key.startsWith('series:'))
    expect(sets).toHaveLength(4)
    expect(sets.every((p) => p.value === 1 && p.group_key.length <= 128)).toBe(true)
  })
})

describe('趋势工具经数据库读取', () => {
  it('get_trend 读取已发布镜像并按上海日历聚合', async () => {
    const { env } = await import('cloudflare:workers')
    const { requestRefresh, runSyncJob } = await import('../src/sync')
    const { getTrend } = await import('../src/trends')
    const c = clock()
    const ownerId = `owner-${crypto.randomUUID()}`
    const up = upstream(() =>
      syncBody({
        weight_list: [
          weight({
            data_id: 'a',
            measured_time: Date.parse('2026-09-14T16:30:00Z') / 1000,
            weight_kg: 70,
            bfr: 20,
          }),
          weight({
            data_id: 'b',
            measured_time: Date.parse('2026-09-14T15:30:00Z') / 1000,
            weight_kg: 72,
            bfr: 25,
          }),
          weight({
            data_id: 'c',
            measured_time: Date.parse('2026-09-14T15:45:00Z') / 1000,
            weight_kg: 74,
            bfr: 30,
          }),
          weight({
            data_id: 'd',
            measured_time: Date.parse('2026-09-14T15:50:00Z') / 1000,
            weight_kg: 999,
            is_deleted: 1,
          }),
        ],
      }),
    )
    const job = await requestRefresh(env.DB, ownerId, 'full', c.now())
    await runSyncJob(env, job.job_id, deps(up.fetch, c.now), { secrets: syntheticSecrets() })
    const ctx = toolContext(ownerId, deps(up.fetch, c.now))
    const out = (
      await getTrend(
        { start: '2026-09-14T00:00:00+08:00', end: '2026-09-21T00:00:00+08:00', interval: 'week' },
        ctx,
      )
    ).data as Loose
    expect(out.formula_version).toBe('trend_v1')
    expect(find(out.points, 'period', 'weight_kg').value).toBe(71.5)
    expect(find(out.points, 'period', 'fat_mass_kg').value).toBeCloseTo(17.05, 10)
  })
})
