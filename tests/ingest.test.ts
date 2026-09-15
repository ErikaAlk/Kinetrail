import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorker } from '../src/index'
import {
  type HcRecord,
  INGEST_PATH,
  type IngestPayload,
  ingestHealthConnect,
  normalizeValue,
} from '../src/ingest'
import { getMeasurements, getSyncStatus } from '../src/queries'
import { acquireLease, scheduledSync } from '../src/sync'
import { clock, deps, toolContext } from './fitdays-mock'
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

// 2026-09-15 手机实读的 14:22 那次称重（research/HEALTHCONNECT.md G-HC2 明细）。
const REAL = [
  rec(1, 'weight', 63.099998474121094),
  rec(2, 'body_fat', 19),
  rec(3, 'body_water_mass', 37.481400056457495),
  rec(4, 'bone_mass', 3.4000000953674316),
  rec(5, 'basal_metabolic_rate', 1473),
  rec(6, 'lean_body_mass', 51.1),
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
    expect(normalizeValue(63.099998474121094)).toBe(63.1)
    expect(normalizeValue(3.4000000953674316)).toBe(3.4)
    expect(normalizeValue(63.04999923706055)).toBe(63.05)
    expect(normalizeValue(37.481400056457495)).toBe(37.481400056457495)
    expect(normalizeValue(1473)).toBe(1473)
  })

  it('一组记录发布为一次测量；原样重发不产生新版本', async () => {
    const owner = crypto.randomUUID()
    expect(await ingest(owner, payload([group(T1, REAL)]))).toMatchObject({ accepted: 1, unchanged: 0 })
    const [m] = await summaries(owner)
    expect(m.profile_ref).toBe(PROFILE)
    expect(m.metrics).toMatchObject({
      weight_kg: 63.1,
      body_fat_pct: 19,
      bone_mass_kg: 3.4,
      bmr_kcal: 1473,
      body_water_pct: 59.4,
    })
    expect(m.quality_flags).toEqual(
      expect.arrayContaining(['source_health_connect', 'body_water_pct_derived_from_mass']),
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
    expect((await summaries(owner))[0].metrics.body_fat_pct).toBe(19)

    const tampered = await ingest(owner, payload([group(T1, [rec(1, 'weight', 80)])]))
    expect(tampered).toMatchObject({ accepted: 0, rejected: [{ time_ms: T1, code: 'HC_GROUP_CONFLICT' }] })
    const swapped = await ingest(owner, payload([group(T1, [rec(99, 'weight', 80)])]))
    expect(swapped).toMatchObject({ rejected: [{ code: 'HC_GROUP_CONFLICT' }] })
    const offset = await ingest(owner, payload([{ ...group(T1, REAL.slice(0, 1)), zone_offset_seconds: 0 }]))
    expect(offset).toMatchObject({ rejected: [{ code: 'HC_GROUP_CONFLICT' }] })
    expect((await summaries(owner))[0].metrics.weight_kg).toBe(63.1)
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
    expect(m.metrics.weight_kg).toBe(63.1)

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
    expect(m.metrics.weight_kg).toBe(63.1)
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
