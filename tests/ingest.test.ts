import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorker } from '../src/index'
import {
  attachReport,
  type HcRecord,
  heightCm,
  INGEST_PATH,
  type IngestPayload,
  ingestHealthConnect,
  normalizeValue,
} from '../src/ingest'
import { getMeasurements, getSyncStatus } from '../src/queries'
import { acquireLease, scheduledSync } from '../src/sync'
import { clock, deps, toolContext } from './fitdays-mock'
import androidReport from './fixtures/android-report.json'
import { dispatch, type Loose, ORIGIN } from './helpers'

const PROFILE = 'p_hc_test_owner'
const CUTOVER = Date.parse('2026-06-01T00:00:00+08:00')
const T1 = Date.parse('2026-09-15T06:22:32Z')
const RANGE = { start: '2026-09-01T00:00:00+08:00', end: '2026-10-01T00:00:00+08:00' }
const TOKEN = 'synthetic-ingest-token-value-0000000000' // SYNTHETIC-SECRET
const noFetch = async () => new Response(null, { status: 599 })

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const rec = (n: number, type: HcRecord['type'], value: number, lastModified = T1 + 600): HcRecord => ({
  hc_id: uuid(n),
  type,
  value,
  last_modified_ms: lastModified,
})
const group = (time: number, records: HcRecord[]) => ({
  origin: 'cn.icomon.fitdayspro',
  time_ms: time,
  zone_offset_seconds: 28800,
  records,
})
const payload = (groups: ReturnType<typeof group>[], deleted: string[] = []): IngestPayload => ({
  schema_version: '1',
  groups,
  deleted_hc_ids: deleted,
})

// 形态照手机实读的一次称重（六个类型、float32 精度与原始 double），数值是合成的。
const REAL = [
  rec(1, 'weight', 70.19999694824219),
  rec(2, 'body_fat', 21),
  rec(3, 'body_water_mass', 41.6988),
  rec(4, 'bone_mass', 3.5999999046325684),
  rec(5, 'basal_metabolic_rate', 1580),
  rec(6, 'lean_body_mass', 55.5),
]

const c = clock(T1 + 3600_000)
const ingest = (owner: string, body: IngestPayload) =>
  ingestHealthConnect(env, owner, PROFILE, CUTOVER, body, deps(noFetch, c.now))
const summaries = async (owner: string, includeDeleted = false) =>
  (
    await getMeasurements(
      { ...RANGE, include_deleted: includeDeleted },
      toolContext(owner, deps(noFetch, c.now)),
    )
  ).data as Loose[]
const versionCount = async (owner: string) =>
  (
    await env.DB.prepare('SELECT COUNT(*) AS n FROM raw_record_versions WHERE owner_id = ?')
      .bind(owner)
      .first<{ n: number }>()
  )?.n

describe('Health Connect 推送：合并与发布', () => {
  it('float32 值取最短十进制，其余原样', () => {
    expect(normalizeValue(70.19999694824219)).toBe(70.2)
    expect(normalizeValue(3.5999999046325684)).toBe(3.6)
    expect(normalizeValue(70.3499984741211)).toBe(70.35)
    expect(normalizeValue(41.6988)).toBe(41.6988)
    expect(normalizeValue(1580)).toBe(1580)
  })

  it('一组记录发布为一次测量；原样重发不产生新版本', async () => {
    const owner = crypto.randomUUID()
    expect(await ingest(owner, payload([group(T1, REAL)]))).toMatchObject({ accepted: 1, unchanged: 0 })
    const [m] = await summaries(owner)
    expect(m.profile_ref).toBe(PROFILE)
    expect(m.metrics).toMatchObject({
      weight_kg: 70.2,
      body_fat_pct: 21,
      bone_mass_kg: 3.6,
      bmr_kcal: 1580,
      body_water_pct: 59.4,
      // 70.2 / 1.75² = 22.92
      bmi: 22.9,
    })
    expect(m.quality_flags).toEqual(
      expect.arrayContaining([
        'source_health_connect',
        'body_water_pct_derived_from_mass',
        'bmi_derived_from_height',
      ]),
    )
    // 记录顺序不同也是同一内容。
    expect(await ingest(owner, payload([group(T1, [...REAL].reverse())]))).toMatchObject({
      accepted: 0,
      unchanged: 1,
    })
    expect(await versionCount(owner)).toBe(1)
    const status = (await getSyncStatus({}, toolContext(owner, deps(noFetch, c.now)))).data as Loose
    expect(status.state).toBe('published')
    expect(status.counts.weight).toBe(1)
  })

  it('逐组拒绝：截断点之前、未来时间、越界、同类型重复、没有体重、同一时刻两组', async () => {
    const owner = crypto.randomUUID()
    const result = await ingest(
      owner,
      payload([
        group(CUTOVER, REAL),
        group(c.now() + 10 * 60_000, REAL),
        group(T1 + 1000, [rec(11, 'weight', 1)]),
        group(T1 + 2000, [rec(12, 'weight', 60), rec(13, 'weight', 60)]),
        group(T1 + 3000, [rec(14, 'body_fat', 20)]),
        group(T1 + 4000, [rec(15, 'weight', 60)]),
        group(T1 + 4000, [rec(16, 'weight', 61)]),
      ]),
    )
    if (typeof result === 'string') throw new Error(result)
    expect(result.rejected.map((r) => r.code)).toEqual([
      'HC_BEFORE_CUTOVER',
      'HC_FUTURE_TIME',
      'HC_VALUE_OUT_OF_RANGE',
      'HC_DUPLICATE_TYPE',
      'HC_DUPLICATE_GROUP',
      'HC_GROUP_WITHOUT_WEIGHT',
    ])
    expect(result.accepted).toBe(1)
    expect((await summaries(owner)).map((s) => s.metrics.weight_kg)).toEqual([60])
  })

  it('已存组只能补新类型；改已有值或同类型换 id 整组拒绝，库里不变', async () => {
    const owner = crypto.randomUUID()
    await ingest(owner, payload([group(T1, [REAL[0] as HcRecord])]))
    expect(await ingest(owner, payload([group(T1, REAL.slice(0, 2))]))).toMatchObject({ accepted: 1 })
    expect((await summaries(owner))[0].metrics.body_fat_pct).toBe(21)

    const tampered = await ingest(owner, payload([group(T1, [rec(1, 'weight', 80)])]))
    expect(tampered).toMatchObject({ accepted: 0, rejected: [{ time_ms: T1, code: 'HC_GROUP_CONFLICT' }] })
    const swapped = await ingest(owner, payload([group(T1, [rec(99, 'weight', 80)])]))
    expect(swapped).toMatchObject({ rejected: [{ code: 'HC_GROUP_CONFLICT' }] })
    const offset = await ingest(owner, payload([{ ...group(T1, REAL.slice(0, 1)), zone_offset_seconds: 0 }]))
    expect(offset).toMatchObject({ rejected: [{ code: 'HC_GROUP_CONFLICT' }] })
    expect((await summaries(owner))[0].metrics.weight_kg).toBe(70.2)
    expect(await versionCount(owner)).toBe(2)
  })

  it('删除：只移出对应记录，删体重即整次作废；已删 id 不再接收，未知 id 只计数', async () => {
    const owner = crypto.randomUUID()
    await ingest(owner, payload([group(T1, REAL)]))
    expect(await ingest(owner, payload([], [uuid(2), uuid(404)]))).toMatchObject({
      accepted: 1,
      deletions_matched: 1,
      deletions_unmatched: 1,
    })
    const [m] = await summaries(owner)
    expect(m.metrics.body_fat_pct).toBeUndefined()
    expect(m.metrics.weight_kg).toBe(70.2)

    // 设备重读时 HC 已经没有被删的记录；即使带上，也不会复活。
    expect(await ingest(owner, payload([group(T1, REAL)]))).toMatchObject({ accepted: 0, unchanged: 1 })
    expect(await ingest(owner, payload([], [uuid(2)]))).toMatchObject({ accepted: 0, deletions_matched: 1 })
    // 已删类型不能换个新 id 补回（否则泄漏令牌可以先删后补、改写数值）。
    expect(await ingest(owner, payload([group(T1, [rec(98, 'body_fat', 25)])]))).toMatchObject({
      accepted: 0,
      rejected: [{ code: 'HC_GROUP_CONFLICT' }],
    })

    expect(await ingest(owner, payload([], [uuid(1)]))).toMatchObject({ accepted: 1 })
    expect(await summaries(owner)).toEqual([])
    const [tombstone] = await summaries(owner, true)
    expect(tombstone.quality_flags).toContain('tombstone')
    // 作废的称重不能用新的体重 id 复活。
    expect(await ingest(owner, payload([group(T1, [rec(99, 'weight', 80)])]))).toMatchObject({
      accepted: 0,
      rejected: [{ code: 'HC_GROUP_CONFLICT' }],
    })
    expect(await summaries(owner)).toEqual([])
    expect(await versionCount(owner)).toBe(3)
  })

  it('附属指标越界只让该指标不进索引，同次称重照常入库', async () => {
    const owner = crypto.randomUUID()
    const result = await ingest(owner, payload([group(T1, [...REAL, rec(7, 'heart_rate', 20)])]))
    expect(result).toMatchObject({ accepted: 1, rejected: [] })
    const [m] = await summaries(owner)
    expect(m.metrics.weight_kg).toBe(70.2)
    expect(m.metrics.heart_rate_bpm).toBeNull()
    expect(m.quality_flags).toContain('heart_rate_out_of_range')
  })

  it('只合并本 profile 的 hc: 记录；HC_PROFILE_REF 与库里已有成员都不符时拒绝写入', async () => {
    const owner = crypto.randomUUID()
    await ingest(owner, payload([group(T1, REAL)]))
    const insertPublished = async (profile: string, sourceRecordId: string, raw: unknown) => {
      const recordId = crypto.randomUUID()
      const text = JSON.stringify(raw)
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO raw_records (id, owner_id, dataset, profile_ref, source_record_id, identity_kind, first_seen_at, last_seen_at)
           VALUES (?, ?, 'weight', ?, ?, 'source_id', 0, 0)`,
        ).bind(recordId, owner, profile, sourceRecordId),
        env.DB.prepare(
          `INSERT INTO raw_record_versions (id, raw_record_id, owner_id, dataset, profile_ref, batch_id, generation, stage_index,
             published, raw_hash, byte_length, raw_format_version, sanitizer_version, raw_json, formula_version, normalization_version, created_at)
           VALUES (?, ?, ?, 'weight', ?, 'manual', 1, 0, 1, 'h', ?, 1, 1, ?, 'body_v1', '1', 0)`,
        ).bind(crypto.randomUUID(), recordId, owner, profile, text.length, text),
      ])
    }
    // 同一本人 profile 下的非 HC 记录恰好含同名字段，以及其他 profile 下的 HC 记录：都不能被删除命中。
    await insertPublished(PROFILE, 'fitdays-data-id', { records: [{ hc_id: uuid(50), type: 'weight' }] })
    await insertPublished('p_other', `hc:cn.icomon.fitdayspro:${T1 + 9000}`, {
      records: [{ hc_id: uuid(51), type: 'weight' }],
      deleted_records: [],
    })
    expect(await ingest(owner, payload([], [uuid(50), uuid(51)]))).toMatchObject({
      accepted: 0,
      deletions_matched: 0,
      deletions_unmatched: 2,
    })

    const other = crypto.randomUUID()
    await env.DB.prepare(
      "INSERT INTO profiles (owner_id, profile_ref, label, updated_at) VALUES (?, 'p_real', NULL, 0)",
    )
      .bind(other)
      .run()
    expect(await ingest(other, payload([group(T1, REAL)]))).toBe('profile_mismatch')
    expect(await versionCount(other)).toBe(0)
  })

  it('BMI 按配置身高推算；身高缺失或不合理时不算', async () => {
    expect(heightCm({ ...env, HC_HEIGHT_CM: '175' })).toBe(175)
    expect(heightCm({ ...env, HC_HEIGHT_CM: '' })).toBeNull()
    expect(heightCm({ ...env, HC_HEIGHT_CM: '1750' })).toBeNull()
    const owner = crypto.randomUUID()
    await ingestHealthConnect(
      { ...env, HC_HEIGHT_CM: '' },
      owner,
      PROFILE,
      CUTOVER,
      payload([group(T1, REAL)]),
      deps(noFetch, c.now),
    )
    const [m] = await summaries(owner)
    expect(m.metrics.weight_kg).toBe(70.2)
    expect(m.metrics.bmi).toBeUndefined()
    expect(m.quality_flags).not.toContain('bmi_derived_from_height')
  })

  it('lease 被占用时返回 busy，不写入', async () => {
    const owner = crypto.randomUUID()
    expect(await acquireLease(env.DB, owner, 'someone-else', c.now())).not.toBeNull()
    expect(await ingest(owner, payload([group(T1, REAL)]))).toBe('busy')
    expect(await versionCount(owner)).toBe(0)
  })

  it('中断的推送批次由调度回收，但不会重排成 FitDays 拉取任务', async () => {
    const owner = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sync_lease (owner_id, generation, holder, expires_at) VALUES (?, 1, 'gone', 0)",
      ).bind(owner),
      env.DB.prepare(
        `INSERT INTO sync_batches (id, owner_id, mode, state, generation, source_region, attempts, created_at)
         VALUES ('hc-crashed', ?, 'incremental', 'staging', 1, 'health_connect', 1, 0)`,
      ).bind(owner),
    ])
    await scheduledSync({ ...env, PERIODIC_SYNC: 'off' }, deps(noFetch, c.now), {
      secrets: { get: () => undefined },
    })
    const rows = await env.DB.prepare('SELECT state FROM sync_batches WHERE owner_id = ?')
      .bind(owner)
      .all<{ state: string }>()
    expect(rows.results.map((r) => r.state)).toEqual(['failed'])
  })
})

// 合成的报告读数（字段与 FitDays+ 报告一致，与 android-report.json 同一份），时间平移到 T1 所在分钟。
const MINUTE = Math.floor(T1 / 60_000) * 60_000
const seg = (kg: number, pct: number) => ({ kg, pct })
const REPORT = {
  measured_minute_ms: MINUTE,
  height_cm: 175,
  age: 30,
  body_score: 76,
  weight_kg: { value: 72.4, min: 56.7, max: 76.6 },
  body_fat_kg: { value: 14.1, min: 8, max: 16.2 },
  bone_mass_kg: { value: 3.9, min: 3.2, max: 4 },
  protein_kg: { value: 11.8, min: 9.7, max: 12.3 },
  body_water_kg: { value: 42.6, min: 35.9, max: 44.6 },
  muscle_kg: { value: 54.4, min: 45.8, max: 57 },
  skeletal_muscle_kg: { value: 32.7, min: 28.5, max: 34.9 },
  body_fat_pct: 19.5,
  bone_mass_pct: 5.4,
  protein_pct: 16.3,
  body_water_pct: 58.8,
  muscle_pct: 75.1,
  skeletal_muscle_pct: 45.2,
  bmi: 23.6,
  obesity_degree_pct: 106,
  target_weight_kg: 68.2,
  weight_control_kg: -4.2,
  fat_control_kg: -4.2,
  muscle_control_kg: 0,
  visceral_fat_level: 5,
  bmr_kcal: 1612,
  fat_free_mass_kg: 58.3,
  subcutaneous_fat_pct: 14.2,
  smi: 8.9,
  body_age: 29,
  whr: 0.9,
  segment_fat: {
    left_arm: seg(0.8, 108.4),
    right_arm: seg(0.7, 99.1),
    trunk: seg(7, 151.3),
    left_leg: seg(2.3, 128.9),
    right_leg: seg(2.3, 127.5),
  },
  segment_muscle: {
    left_arm: seg(3.2, 103.6),
    right_arm: seg(3.3, 105.9),
    trunk: seg(25.1, 101.4),
    left_leg: seg(9.4, 105.2),
    right_leg: seg(9.4, 105.2),
  },
  impedance_ohm: {
    khz_20: { right_arm: 305.4, left_arm: 327.9, trunk: 20.6, right_leg: 243.1, left_leg: 262.7 },
    khz_100: { right_arm: 262, left_arm: 284.3, trunk: 18.1, right_leg: 208.5, left_leg: 226.4 },
  },
}
const MATCHING = [
  rec(21, 'weight', 72.4000015258789),
  rec(22, 'body_fat', 19.5),
  rec(23, 'body_water_mass', 42.5712),
  rec(24, 'bone_mass', 3.9),
  rec(25, 'basal_metabolic_rate', 1612),
  rec(26, 'lean_body_mass', 58.3),
]
const withReports = (body: IngestPayload, reports: unknown[]) => ({ ...body, reports }) as IngestPayload

describe('识图报告：挂到同一次称重', () => {
  const rawOf = async (owner: string, time: number) =>
    JSON.parse(
      (
        await env.DB.prepare(
          `SELECT v.raw_json FROM raw_record_versions v JOIN raw_records r ON r.id = v.raw_record_id
           WHERE r.owner_id = ? AND r.source_record_id = ? ORDER BY v.generation DESC, v.stage_index DESC LIMIT 1`,
        )
          .bind(owner, `hc:cn.icomon.fitdayspro:${time}`)
          .first<{ raw_json: string }>()
      )?.raw_json ?? 'null',
    )

  it('只挂到分钟内体重相同的那组：补齐 HC 没有的指标，HC 已有的不覆盖；原样重发不变，改值拒绝', async () => {
    const owner = crypto.randomUUID()
    // 线上同样的情形：上一分钟 50 秒还有一次数值相同的称重，报告时间截断到分钟，只对应后一组。
    const earlier = MINUTE - 10_000
    const earlierRecords = MATCHING.map((r, i) => ({ ...r, hc_id: uuid(100 + i) }))
    await ingest(owner, payload([group(earlier, earlierRecords), group(T1, MATCHING)]))
    const result = await ingest(owner, withReports(payload([]), [REPORT]))
    expect(result).toMatchObject({ accepted: 1, unchanged: 0, rejected: [] })

    const [before, m] = await summaries(owner)
    expect(before.quality_flags).not.toContain('report_attached')
    expect(m.quality_flags).toContain('report_attached')
    expect(m.metrics).toMatchObject({
      weight_kg: 72.4,
      body_fat_pct: 19.5,
      // HC 水分质量推算的 58.8 与 bmi 推算值保留，报告不覆盖。
      body_water_pct: 58.8,
      bmi: 23.6,
      muscle_pct: 75.1,
      skeletal_muscle_pct: 45.2,
      protein_pct: 16.3,
      subcutaneous_fat_pct: 14.2,
      visceral_fat_index: 5,
      body_age: 29,
      smi: 8.9,
      whr: 0.9,
    })
    const raw = await rawOf(owner, T1)
    expect(raw.report.impedance_ohm.khz_20.left_arm).toBe(327.9)
    expect(Object.keys(raw)).toEqual([
      'source',
      'origin',
      'time_ms',
      'zone_offset_seconds',
      'records',
      'deleted_records',
      'report',
    ])

    // 键顺序不同也是同一份报告。
    const reordered = Object.fromEntries(Object.entries(REPORT).reverse())
    expect(await ingest(owner, withReports(payload([]), [reordered]))).toMatchObject({
      accepted: 0,
      unchanged: 1,
      rejected: [],
    })
    expect(await ingest(owner, withReports(payload([]), [{ ...REPORT, body_age: 30 }]))).toMatchObject({
      accepted: 0,
      rejected: [{ time_ms: MINUTE, code: 'REPORT_CONFLICT' }],
    })
    expect((await summaries(owner))[1].metrics.body_age).toBe(29)
    expect(await versionCount(owner)).toBe(3)
  })

  it('找不到、多个候选、体脂对不上、同分钟两份报告都拒绝，不写入', async () => {
    const owner = crypto.randomUUID()
    await ingest(owner, payload([group(T1, MATCHING)]))
    const reject = async (reports: unknown[]) => {
      const result = await ingest(owner, withReports(payload([]), reports))
      if (typeof result === 'string') throw new Error(result)
      expect(result.accepted).toBe(0)
      return result.rejected.map((r) => r.code)
    }
    expect(await reject([{ ...REPORT, measured_minute_ms: MINUTE + 60_000 }])).toEqual(['REPORT_NO_MATCH'])
    // 查库按分钟窗口取候选，窗口两端在匹配函数里同样要成立；容差边界：体重 0.01、体脂 0.05。
    const stored = (time: number) => ({
      ...group(time, MATCHING),
      source: 'health_connect' as const,
      deleted_records: [],
    })
    expect(attachReport([stored(T1)], { ...REPORT, measured_minute_ms: MINUTE - 60_000 })).toBe(
      'REPORT_NO_MATCH',
    )
    expect(attachReport([stored(MINUTE - 10_000)], REPORT)).toBe('REPORT_NO_MATCH')
    expect(attachReport([stored(T1)], { ...REPORT, weight_kg: { value: 72.41 } })).not.toBeTypeOf('string')
    expect(attachReport([stored(T1)], { ...REPORT, weight_kg: { value: 72.42 } })).toBe('REPORT_NO_MATCH')
    expect(attachReport([stored(T1)], { ...REPORT, body_fat_pct: 19.55 })).not.toBeTypeOf('string')
    expect(attachReport([stored(T1)], { ...REPORT, body_fat_pct: 19.56 })).toBe('REPORT_MISMATCH')
    expect(await reject([{ ...REPORT, weight_kg: { value: 72.3 } }])).toEqual(['REPORT_NO_MATCH'])
    expect(await reject([{ ...REPORT, body_fat_pct: 19.7 }])).toEqual(['REPORT_MISMATCH'])
    expect(await versionCount(owner)).toBe(1)
    // 同一分钟两份：后一份拒绝，前一份照常处理。
    expect(
      await ingest(owner, withReports(payload([]), [REPORT, { ...REPORT, body_age: 30 }])),
    ).toMatchObject({ accepted: 1, rejected: [{ code: 'REPORT_DUPLICATE' }] })

    const twice = crypto.randomUUID()
    const again = MATCHING.map((r, i) => ({ ...r, hc_id: uuid(200 + i) }))
    await ingest(twice, payload([group(T1, MATCHING), group(T1 + 5000, again)]))
    const ambiguous = await ingest(twice, withReports(payload([]), [REPORT]))
    expect(ambiguous).toMatchObject({ accepted: 0, rejected: [{ code: 'REPORT_AMBIGUOUS' }] })
  })

  it('同一请求里新到的称重可以挂；已作废的称重不能挂；之后补类型或删附属记录都保留报告', async () => {
    const owner = crypto.randomUUID()
    const weightOnly = [MATCHING[0] as HcRecord]
    const report = { ...REPORT, body_water_pct: 58 }
    expect(await ingest(owner, withReports(payload([group(T1, weightOnly)]), [report]))).toMatchObject({
      accepted: 1,
      rejected: [],
    })
    expect((await summaries(owner))[0].metrics.body_water_pct).toBe(58)
    await ingest(owner, payload([group(T1, MATCHING)]))
    expect((await rawOf(owner, T1)).report.body_score).toBe(76)
    // HC 水分质量到了以后以 HC 推算值为准。
    expect((await summaries(owner))[0].metrics.body_water_pct).toBe(58.8)
    await ingest(owner, payload([], [uuid(22)]))
    const [m] = await summaries(owner)
    // 在 HC 里删掉的体脂不让报告带回来。
    expect(m.metrics.body_fat_pct).toBeUndefined()
    expect(m.metrics.muscle_pct).toBe(75.1)
    expect((await rawOf(owner, T1)).report.body_score).toBe(76)

    const gone = crypto.randomUUID()
    await ingest(gone, payload([group(T1, MATCHING)], [uuid(21)]))
    expect(await ingest(gone, withReports(payload([]), [REPORT]))).toMatchObject({
      rejected: [{ code: 'REPORT_NO_MATCH' }],
    })
  })
})

describe('识图报告：不能借报告改写 HC 的值', () => {
  it('先删 HC 体脂再挂报告：不同体脂拒绝，相同的也不把删掉的指标带回来', async () => {
    const owner = crypto.randomUUID()
    await ingest(owner, payload([group(T1, MATCHING)], [uuid(22), uuid(24)]))
    expect(await ingest(owner, withReports(payload([]), [{ ...REPORT, body_fat_pct: 5 }]))).toMatchObject({
      accepted: 0,
      rejected: [{ code: 'REPORT_MISMATCH' }],
    })
    expect(await ingest(owner, withReports(payload([]), [REPORT]))).toMatchObject({
      accepted: 1,
      rejected: [],
    })
    const [m] = await summaries(owner)
    expect(m.metrics.body_fat_pct).toBeUndefined()
    expect(m.metrics.bone_mass_kg).toBeUndefined()
    expect(m.metrics.skeletal_muscle_pct).toBe(45.2)
  })

  it('HC 水分质量越界时不用报告的水分率顶上', async () => {
    const owner = crypto.randomUUID()
    const records = [MATCHING[0] as HcRecord, rec(40, 'body_water_mass', 500)]
    await ingest(owner, withReports(payload([group(T1, records)]), [REPORT]))
    const [m] = await summaries(owner)
    expect(m.quality_flags).toEqual(
      expect.arrayContaining(['body_water_mass_out_of_range', 'report_attached']),
    )
    expect(m.metrics.body_water_pct).toBeUndefined()
  })

  it('报告先到、HC 体脂后到且不一致时，原样重发报告仍是未变', async () => {
    const owner = crypto.randomUUID()
    await ingest(owner, withReports(payload([group(T1, [MATCHING[0] as HcRecord])]), [REPORT]))
    await ingest(owner, payload([group(T1, [MATCHING[0] as HcRecord, rec(41, 'body_fat', 20)])]))
    expect(await ingest(owner, withReports(payload([]), [REPORT]))).toMatchObject({
      accepted: 0,
      unchanged: 1,
      rejected: [],
    })
  })
})

describe('Health Connect 推送：HTTP 边界', () => {
  afterEach(() => vi.restoreAllMocks())
  const worker = createWorker(deps(noFetch, c.now))
  let ip = 0
  const post = (body: string, headers: Record<string, string> = {}) =>
    dispatch(
      worker,
      new Request(`${ORIGIN}${INGEST_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'cf-connecting-ip': `203.0.113.${++ip}`,
          ...headers,
        },
        body,
      }),
    )

  it('手机端生成的报告 JSON（与 Android 单测共用的夹具）经 HTTP 挂到同一请求里的称重上', async () => {
    const response = await post(
      JSON.stringify(
        withReports(
          payload([
            group(
              T1 + 7000,
              MATCHING.map((r, i) => ({ ...r, hc_id: uuid(300 + i) })),
            ),
          ]),
          [{ ...androidReport, measured_minute_ms: MINUTE }],
        ),
      ),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ accepted: 1, rejected: [] })
  })

  it('鉴权通过后写入，响应只含计数', async () => {
    const response = await post(JSON.stringify(payload([group(T1, REAL)])))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      accepted: 1,
      unchanged: 0,
      rejected: [],
      deletions_matched: 0,
      deletions_unmatched: 0,
    })
  })

  it('错误令牌、方法、类型、大小、格式在写库前拒绝，日志不含令牌', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)))
    const body = JSON.stringify(payload([group(T1 + 5000, REAL)]))
    expect((await post(body, { authorization: 'Bearer wrong-token' })).status).toBe(401)
    expect((await post(body, { authorization: '' })).status).toBe(401)
    const get = await dispatch(worker, new Request(`${ORIGIN}${INGEST_PATH}`))
    expect(get.status).toBe(404)
    expect((await post(body, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post(' '.repeat(64 * 1024 + 1))).status).toBe(413)
    expect((await post('{not json')).status).toBe(400)
    const invalid = [
      { ...payload([]), extra: 1 },
      payload([{ ...group(T1, REAL), origin: 'com.other.app' }]),
      payload([group(T1, [{ ...(REAL[0] as HcRecord), hc_id: 'not-a-uuid' }])]),
      payload([group(T1, [{ ...(REAL[0] as HcRecord), type: 'steps' as HcRecord['type'] }])]),
      { schema_version: '1', groups: [] },
      // 报告只收数字；时间必须整分钟；分段五个部位齐全。
      withReports(payload([]), [{ ...REPORT, note: '手写' }]),
      withReports(payload([]), [{ ...REPORT, body_age: '18' }]),
      withReports(payload([]), [{ ...REPORT, measured_minute_ms: MINUTE + 1000 }]),
      withReports(payload([]), [{ ...REPORT, segment_fat: { trunk: seg(7, 151.3) } }]),
      withReports(payload([]), [{ measured_minute_ms: MINUTE }]),
    ]
    for (const bad of invalid) {
      const response = await post(JSON.stringify(bad))
      expect(response.status, JSON.stringify(bad)).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_payload' })
    }
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM raw_records WHERE source_record_id = 'hc:cn.icomon.fitdayspro:' || ?",
    )
      .bind(T1 + 5000)
      .first<{ n: number }>()
    expect(stored?.n).toBe(0)
    expect(logs.join('\n')).not.toContain(TOKEN)
    expect(logs.join('\n')).toContain('"status":"unauthorized"')
  })

  it('未配置令牌时与不存在的路径一致；缺少截断点或 profile 时 503；同一 IP 超过每分钟 30 次返回 429', async () => {
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext
    const off = await worker.fetch(
      new Request(`${ORIGIN}${INGEST_PATH}`, { method: 'POST', body: '{}' }),
      { ...env, HC_INGEST_TOKEN_SHA256: undefined },
      ctx,
    )
    expect(off.status).toBe(404)
    const unconfigured = await worker.fetch(
      new Request(`${ORIGIN}${INGEST_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'cf-connecting-ip': '192.0.2.1',
        },
        body: JSON.stringify(payload([group(T1, REAL)])),
      }),
      { ...env, HC_PROFILE_REF: '' },
      ctx,
    )
    expect(unconfigured.status).toBe(503)
    expect(await unconfigured.json()).toEqual({ error: 'not_configured' })

    const statuses: number[] = []
    for (let i = 0; i < 31; i++) {
      const response = await post('{}', { 'cf-connecting-ip': '198.51.100.7', authorization: 'Bearer wrong' })
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true)
    expect(statuses[30]).toBe(429)
  })

  it('鉴权通过的请求全局每分钟最多 60 次，换 IP 也一样', async () => {
    const other = createWorker(deps(noFetch, () => c.now() + 3600_000))
    const statuses: number[] = []
    for (let i = 0; i < 61; i++) {
      const response = await dispatch(
        other,
        new Request(`${ORIGIN}${INGEST_PATH}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            'cf-connecting-ip': `198.18.${Math.floor(i / 250)}.${i % 250}`,
          },
          body: JSON.stringify(payload([])),
        }),
      )
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true)
    expect(statuses[60]).toBe(429)
  })
})
