import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { type HcRecord, type IngestPayload, ingestHealthConnect } from '../src/ingest'
import { getMeasurements } from '../src/queries'
import { decodeA7, handleScale, ingestScale, SCALE_PATH, type ScalePayload } from '../src/scale'
import { acquireLease, scheduledSync } from '../src/sync'
import { sha256Hex } from '../src/util'
import { clock, deps, toolContext } from './fitdays-mock'
import gatewayItem from './fixtures/gateway-measurement.json'
import type { Loose } from './helpers'

const PROFILE = 'p_hc_test_owner'
const HC_CUTOVER = Date.parse('2026-06-01T00:00:00+08:00')
const SCALE_CUTOVER = Date.parse('2026-09-20T00:00:00+08:00')
const T_HC = Date.parse('2026-09-19T08:00:00+08:00')
// 夹具的时刻：2026-09-21T08:00:00+08:00
const T_SCALE = gatewayItem.time_ms
const RANGE = { start: '2026-09-01T00:00:00+08:00', end: '2026-10-01T00:00:00+08:00' }
const TOKEN = 'synthetic-scale-token-value-000000000000' // SYNTHETIC-SECRET
const noFetch = async () => new Response(null, { status: 599 })
const c = clock(Date.parse('2026-09-22T12:00:00+08:00'))

type Item = ScalePayload['measurements'][number]
const item = (overrides: Partial<Item> = {}): Item => ({ ...(gatewayItem as Item), ...overrides })
const body = (...items: Item[]): ScalePayload => ({ schema_version: '1', measurements: items })

/** 合成 A7 载荷：时间戳字节、算法号、体重（克）、阻抗（欧姆）、4 个尾字节。 */
function a7(weightG: number, imps: number[], alg = 0x25, stamp = 0x6a000001): string {
  const bytes = [
    0xa7,
    (stamp >>> 24) & 255,
    (stamp >>> 16) & 255,
    (stamp >>> 8) & 255,
    stamp & 255,
    alg,
    (weightG >> 16) & 255,
    (weightG >> 8) & 255,
    weightG & 255,
    0,
    imps.length,
    ...imps.flatMap((z) => [Math.round(z * 10) >> 8, Math.round(z * 10) & 255]),
    0,
    0,
    0,
    0,
  ]
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}
const IMPS = [30, 300, 300, 280, 280, 25, 280, 280, 250, 250]
/** 只有体重与 BMI 的推送项（身高 175）。 */
const weightOnly = (weightKg: number, time: number, stamp = 0x6a000001): Item => ({
  ...item({ time_ms: time, a7_hex: a7(Math.round(weightKg * 1000), IMPS, 0x25, stamp) }),
  metrics: { bmi: Math.round(((weightKg * 10_000) / 175 ** 2) * 10) / 10 },
})

const ingest = (owner: string, payload: ScalePayload, windowKg = 4) =>
  ingestScale(env, owner, PROFILE, SCALE_CUTOVER, windowKg, payload, deps(noFetch, c.now))

/** 用一次 Health Connect 称重给本人垫一个参考体重。 */
const seed = (owner: string, weightKg: number, time = T_HC, n = 1) => {
  const record: HcRecord = {
    hc_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    type: 'weight',
    value: weightKg,
    last_modified_ms: time,
  }
  const payload: IngestPayload = {
    schema_version: '1',
    groups: [
      { origin: 'cn.icomon.fitdayspro', time_ms: time, zone_offset_seconds: 28800, records: [record] },
    ],
    deleted_hc_ids: [],
  }
  return ingestHealthConnect(env, owner, PROFILE, HC_CUTOVER, payload, deps(noFetch, c.now))
}

const measurements = async (owner: string) =>
  ((await getMeasurements(RANGE, toolContext(owner, deps(noFetch, c.now)))).data as Loose[]).filter((m) =>
    m.quality_flags.includes('source_ble_p3'),
  )

describe('体脂秤网关：解帧', () => {
  it('体重按 u24 读，阻抗十个，长度不对或不是 A7 就不解', () => {
    const frame = decodeA7(gatewayItem.a7_hex)
    expect(frame).toEqual({
      weightKg: 70,
      impedancesOhm: [30, 300, 300, 280, 280, 25, 280, 280, 250, 250],
      algorithm: 37,
    })
    // 65.535 kg 以上 u16 会溢出
    expect(decodeA7(a7(80_500, IMPS))?.weightKg).toBe(80.5)
    expect(decodeA7(gatewayItem.a7_hex.slice(0, 40))).toBeNull() // 阻抗没收全
    expect(decodeA7(`${gatewayItem.a7_hex}${'00'.repeat(9)}`)).toBeNull() // 尾巴多得离谱
    expect(decodeA7(`a2${gatewayItem.a7_hex.slice(2)}`)).toBeNull()
  })
})

describe('体脂秤网关：入库', () => {
  it('窗口内的称重入库：体重来自帧，体成分来自网关；同一帧再来保留第一次的时刻', async () => {
    const owner = crypto.randomUUID()
    await seed(owner, 70.2)
    expect(await ingest(owner, body(item()))).toEqual({ accepted: 1, unchanged: 0, rejected: [] })

    const [m] = await measurements(owner)
    expect(m.measured_at).toBe('2026-09-21T08:00:00+08:00')
    expect(m.metrics).toMatchObject({
      weight_kg: 70,
      bmi: 22.9,
      body_fat_pct: 20.5,
      muscle_pct: 74.2,
      visceral_fat_index: 5,
      body_age: 35,
    })
    expect(m.metrics.body_score).toBeUndefined() // 只在 raw
    expect(m.metrics.fat_mass_kg).toBeCloseTo(70 * 0.205, 6)
    expect(m.quality_flags).toEqual(['source_ble_p3', 'wla37_computed_by_gateway'])

    const row = await env.DB.prepare(
      "SELECT r.source_record_id AS key, r.identity_kind AS kind, v.raw_json AS raw FROM raw_records r JOIN raw_record_versions v ON v.raw_record_id = r.id WHERE r.owner_id = ? AND r.source_record_id LIKE 'ble:%'",
    )
      .bind(owner)
      .first<{ key: string; kind: string; raw: string }>()
    expect(row?.key).toBe(`ble:p3:${(await sha256Hex(gatewayItem.a7_hex)).slice(0, 32)}`)
    expect(row?.kind).toBe('content_hash')
    expect(JSON.parse(row?.raw ?? '{}')).toMatchObject({
      source: 'ble',
      a7_hex: gatewayItem.a7_hex,
      impedances_ohm: IMPS,
      inputs: gatewayItem.inputs,
    })

    // 秤下次连接重发缓存的同一帧：不产生新版本，时刻不变
    const again = await ingest(owner, body(item({ time_ms: T_SCALE + 3600_000 })))
    expect(again).toEqual({ accepted: 0, unchanged: 1, rejected: [] })
    const after = await measurements(owner)
    expect(after).toHaveLength(1)
    expect(after[0].measured_at).toBe('2026-09-21T08:00:00+08:00')
  })

  it('阻抗不可用时只有体重和 BMI', async () => {
    const owner = crypto.randomUUID()
    await seed(owner, 70.2)
    expect(await ingest(owner, body(weightOnly(70.4, T_SCALE)))).toMatchObject({ accepted: 1 })
    const [m] = await measurements(owner)
    expect(m.metrics).toEqual({ weight_kg: 70.4, bmi: 23 })
    expect(m.quality_flags).toEqual(['source_ble_p3', 'weight_only'])
  })

  it('逐条拒绝：不是本人、没有参考、截断点之前、未来、BMI 与帧不符、非 P3 算法带体成分、帧读错、同帧重复', async () => {
    const fresh = crypto.randomUUID()
    expect(await ingest(fresh, body(item()))).toEqual({
      accepted: 0,
      unchanged: 0,
      rejected: [{ time_ms: T_SCALE, code: 'SCALE_NO_REFERENCE' }],
    })

    const owner = crypto.randomUUID()
    await seed(owner, 70.2)
    const result = await ingest(
      owner,
      body(
        weightOnly(74.3, T_SCALE + 1000, 2), // 比参考重 4.1 kg
        weightOnly(65.9, T_SCALE + 2000, 3), // 轻 4.3 kg
        weightOnly(70, SCALE_CUTOVER, 4),
        weightOnly(70, c.now() + 10 * 60_000, 5),
        { ...weightOnly(70, T_SCALE + 3000, 6), metrics: { bmi: 24.5 } },
        item({ time_ms: T_SCALE + 4000, a7_hex: a7(70_000, IMPS, 0x19, 7) }),
        item({ time_ms: T_SCALE + 5000, a7_hex: gatewayItem.a7_hex.slice(0, 40) }),
        item({ time_ms: T_SCALE + 6000 }),
        item({ time_ms: T_SCALE + 7000 }),
      ),
    )
    if (typeof result === 'string') throw new Error(result)
    result.rejected.sort((a, b) => a.time_ms - b.time_ms)
    expect(result).toEqual({
      accepted: 1,
      unchanged: 0,
      rejected: [
        { time_ms: T_SCALE + 1000, code: 'SCALE_WEIGHT_OUT_OF_WINDOW' },
        { time_ms: T_SCALE + 2000, code: 'SCALE_WEIGHT_OUT_OF_WINDOW' },
        { time_ms: SCALE_CUTOVER, code: 'SCALE_BEFORE_CUTOVER' },
        { time_ms: c.now() + 10 * 60_000, code: 'SCALE_FUTURE_TIME' },
        { time_ms: T_SCALE + 3000, code: 'SCALE_METRICS_INCONSISTENT' },
        { time_ms: T_SCALE + 4000, code: 'SCALE_METRICS_INCONSISTENT' },
        { time_ms: T_SCALE + 5000, code: 'SCALE_FRAME_INVALID' },
        { time_ms: T_SCALE + 7000, code: 'SCALE_DUPLICATE' },
      ].sort((a, b) => a.time_ms - b.time_ms),
    })
    // 被拒的一条也不落库：库里只有垫的那次 HC 称重和通过的这一条
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM raw_records WHERE owner_id = ?')
      .bind(owner)
      .first<{ n: number }>()
    expect(rows?.n).toBe(2)
  })

  it('参考是近 14 天的中位数；更早的只看最近一条', async () => {
    const owner = crypto.randomUUID()
    const day = 86_400_000
    await seed(owner, 60, T_SCALE - 30 * day, 1) // 太早，被近 14 天的数据盖过
    await seed(owner, 70, T_SCALE - 3 * day, 2)
    await seed(owner, 71, T_SCALE - 2 * day, 3)
    await seed(owner, 90, T_SCALE - day, 4) // 一条离谱的不影响中位数
    expect(await ingest(owner, body(weightOnly(72.5, T_SCALE)))).toMatchObject({ accepted: 1 })

    const old = crypto.randomUUID()
    await seed(old, 60, T_SCALE - 30 * day)
    expect(await ingest(old, body(weightOnly(63, T_SCALE)))).toMatchObject({ accepted: 1 })
  })

  it('lease 被占用时 busy，不写入', async () => {
    const owner = crypto.randomUUID()
    await seed(owner, 70.2)
    expect(await acquireLease(env.DB, owner, 'someone-else', c.now())).not.toBeNull()
    expect(await ingest(owner, body(item()))).toBe('busy')
    expect(await measurements(owner)).toHaveLength(0)
  })

  it('切换点之后 Health Connect 的称重拒绝 HC_AFTER_CUTOVER，之前的照收', async () => {
    const owner = crypto.randomUUID()
    const hc = (time: number, n: number): IngestPayload => ({
      schema_version: '1',
      groups: [
        {
          origin: 'cn.icomon.fitdayspro',
          time_ms: time,
          zone_offset_seconds: 28800,
          records: [
            {
              hc_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
              type: 'weight',
              value: 70,
              last_modified_ms: time,
            },
          ],
        },
      ],
      deleted_hc_ids: [],
    })
    const run = (p: IngestPayload) =>
      ingestHealthConnect(env, owner, PROFILE, HC_CUTOVER, p, deps(noFetch, c.now), SCALE_CUTOVER)
    expect(await run(hc(SCALE_CUTOVER, 1))).toMatchObject({ accepted: 1, rejected: [] })
    expect(await run(hc(SCALE_CUTOVER + 1, 2))).toMatchObject({
      accepted: 0,
      rejected: [{ time_ms: SCALE_CUTOVER + 1, code: 'HC_AFTER_CUTOVER' }],
    })
  })

  it('中断的网关批次由调度回收，但不会重排成 FitDays 拉取任务', async () => {
    const owner = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sync_lease (owner_id, generation, holder, expires_at) VALUES (?, 1, 'gone', 0)",
      ).bind(owner),
      env.DB.prepare(
        `INSERT INTO sync_batches (id, owner_id, mode, state, generation, source_region, attempts, created_at)
         VALUES ('ble-crashed', ?, 'incremental', 'staging', 1, 'ble', 1, 0)`,
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

describe('体脂秤网关：HTTP', () => {
  const configured = {
    ...env,
    // sha256('synthetic-scale-token-value-000000000000')
    SCALE_INGEST_TOKEN_SHA256: '', // 在 beforeAll 里算
    SCALE_ACCEPT_AFTER: '2026-09-20T00:00:00+08:00',
    SCALE_WEIGHT_WINDOW_KG: '4',
  }
  const post = async (e: Env, token: string, payload: unknown, ip = '192.0.2.10') =>
    handleScale(
      new Request(`https://kinetrail.test${SCALE_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify(payload),
      }),
      e,
      deps(noFetch, c.now),
    )

  it('独立令牌：手机令牌写不进来；未配置令牌 404；缺配置 503；格式不对 400；通过后只回计数', async () => {
    const e = {
      ...configured,
      SCALE_INGEST_TOKEN_SHA256: await sha256Hex(TOKEN),
      OWNER_ID: crypto.randomUUID(),
    }
    await seed(e.OWNER_ID, 70.2)

    expect((await post({ ...e, SCALE_INGEST_TOKEN_SHA256: '' }, TOKEN, body(item()))).status).toBe(404)
    expect(
      (await post(e, 'synthetic-ingest-token-value-0000000000', body(item()), '192.0.2.11')).status,
    ).toBe(401) // SYNTHETIC-SECRET
    expect((await post({ ...e, SCALE_ACCEPT_AFTER: '' }, TOKEN, body(item()), '192.0.2.12')).status).toBe(503)
    expect(
      (await post({ ...e, SCALE_WEIGHT_WINDOW_KG: '0' }, TOKEN, body(item()), '192.0.2.12')).status,
    ).toBe(503)
    const extra = { ...item(), note: 'free text' }
    expect((await post(e, TOKEN, { schema_version: '1', measurements: [extra] }, '192.0.2.13')).status).toBe(
      400,
    )
    expect(
      (await post(e, TOKEN, body(item({ a7_hex: `A7${gatewayItem.a7_hex.slice(2)}` })), '192.0.2.13')).status,
    ).toBe(400)

    const ok = await post(e, TOKEN, body(item()), '192.0.2.14')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ accepted: 1, unchanged: 0, rejected: [] })
  })
})
