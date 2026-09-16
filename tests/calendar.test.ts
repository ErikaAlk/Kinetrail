import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { CALENDAR_PATH } from '../src/calendar'
import { createWorker } from '../src/index'
import { ingestHealthConnect } from '../src/ingest'
import type { ToolContext } from '../src/mcp'
import {
  amendWorkoutEntry,
  finalizeWorkoutSession,
  recordWorkoutEvent,
  startWorkoutSession,
} from '../src/workouts'
import { clock, deps, toolContext } from './fitdays-mock'
import calendarFixture from './fixtures/calendar-response.json'
import { type Loose, ORIGIN } from './helpers'

// 与 ingest.test.ts 同一套合成值：测试环境的 HC_INGEST_TOKEN_SHA256 就是这个令牌的哈希。
const TOKEN = 'synthetic-ingest-token-value-0000000000' // SYNTHETIC-SECRET
const PROFILE = 'p_hc_test_owner'
const CUTOVER = Date.parse('2026-06-01T00:00:00+08:00')
const NOW = Date.parse('2026-09-20T12:00:00Z')
const noFetch = async () => new Response(null, { status: 599 })
const key = () => crypto.randomUUID()
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const treadmill = {
  exercise_name_raw: '跑步机',
  category: 'cardio' as const,
  sets: [{ duration_seconds: 1200, distance_value: 3, distance_unit: 'km' as const }],
}

const pulldown = {
  exercise_name_raw: '高位下拉',
  category: 'strength' as const,
  equipment_label: '器械A',
  sets: [
    { load_value: 45, load_unit: 'kg' as const, reps: 12 },
    { load_value: 45, load_unit: 'kg' as const, reps: 10 },
  ],
}

function setup() {
  const c = clock(NOW)
  const ownerId = `owner-${crypto.randomUUID()}`
  return { ownerId, ctx: toolContext(ownerId, deps(noFetch, c.now)) }
}

/** 记录一次训练（不传 session_id 时会新建会话），返回收据。 */
async function record(ctx: ToolContext, occurredAt: string, entries: Loose[] = [pulldown]): Promise<Loose> {
  const outcome = await recordWorkoutEvent(
    {
      idempotency_key: key(),
      expected_revision: 0,
      occurred_at: occurredAt,
      timezone: 'Asia/Shanghai',
      raw_text: '我已完成高位下拉45kg，12、10次',
      completion: 'completed',
      entries,
    } as Parameters<typeof recordWorkoutEvent>[0],
    ctx,
  )
  return outcome.data as Loose
}

async function finalize(
  ctx: ToolContext,
  receipt: Loose,
  endedAt: string,
  calories?: number,
  extra: Record<string, unknown> = {},
): Promise<Loose> {
  const outcome = await finalizeWorkoutSession(
    {
      idempotency_key: key(),
      expected_revision: receipt.revision,
      session_id: receipt.session_id,
      ended_at: endedAt,
      raw_text: '练完了',
      duration_seconds: 3600,
      calories_kcal: calories,
      ...extra,
    } as Parameters<typeof finalizeWorkoutSession>[0],
    ctx,
  )
  return outcome.data as Loose
}

/** 写一次 Health Connect 称重（含体脂），直接走推送入口，进的是已发布快照。 */
async function weighIn(ownerId: string, timeMs: number, weightKg: number, n: number) {
  const c = clock(NOW)
  return ingestHealthConnect(
    env,
    ownerId,
    PROFILE,
    CUTOVER,
    {
      schema_version: '1',
      groups: [
        {
          origin: 'cn.icomon.fitdayspro',
          time_ms: timeMs,
          zone_offset_seconds: 28800,
          records: [
            { hc_id: uuid(n), type: 'weight', value: weightKg, last_modified_ms: timeMs + 10 },
            { hc_id: uuid(n + 1), type: 'body_fat', value: 19, last_modified_ms: timeMs + 10 },
          ],
        },
      ],
      deleted_hc_ids: [],
    },
    deps(noFetch, c.now),
  )
}

async function get(
  ownerId: string,
  query: string,
  token: string | null = TOKEN,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: Loose }> {
  const worker = createWorker(deps(noFetch, clock(NOW).now))
  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request(`${ORIGIN}${CALENDAR_PATH}?${query}`, {
      headers: {
        'cf-connecting-ip': '192.0.2.10',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }),
    { ...env, OWNER_ID: ownerId, ...overrides },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  const text = await response.text()
  // 404 走的是 "Not found" 纯文本，与不存在的路径一致。
  const json = text.startsWith('{') ? (JSON.parse(text) as Loose) : null
  return { status: response.status, body: json }
}

const SEPT = 'from=2026-09-01&to=2026-09-30'
const dayOf = (body: Loose, date: string): Loose => body.days.find((d: Loose) => d.date === date)

describe('日历读取入口', () => {
  it('没有令牌、令牌不对、未配置令牌、非 GET 都拿不到数据', async () => {
    const { ownerId } = setup()
    expect((await get(ownerId, SEPT, null)).status).toBe(401)
    expect((await get(ownerId, SEPT, 'wrong-token-value-0000000000000000')).status).toBe(401)
    expect((await get(ownerId, SEPT, TOKEN, { HC_INGEST_TOKEN_SHA256: undefined })).status).toBe(404)

    const worker = createWorker(deps(noFetch, clock(NOW).now))
    const ctx = createExecutionContext()
    const post = await worker.fetch(
      new Request(`${ORIGIN}${CALENDAR_PATH}?${SEPT}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'cf-connecting-ip': '192.0.2.11' },
      }),
      { ...env, OWNER_ID: ownerId },
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(post.status).toBe(404)
  })

  it('范围非法时拒绝', async () => {
    const { ownerId } = setup()
    for (const query of [
      '',
      'from=2026-09-01',
      'from=2026-9-1&to=2026-09-30',
      'from=2026-02-30&to=2026-03-02',
      'from=2026-09-30&to=2026-09-01',
      'from=2026-01-01&to=2026-12-31',
      'from=2026-08-01&to=2026-10-02',
      'from=2026-09-01&to=2026-09-30&tz=Mars/Olympus',
    ]) {
      expect((await get(ownerId, query)).status, query).toBe(400)
    }
    // 含首含尾 62 天整好在上限内，63 天超了（上一组里的 8-01 → 10-02）
    expect((await get(ownerId, 'from=2026-08-01&to=2026-10-01')).status).toBe(200)
  })

  it('按自然日返回训练与体测，热量按天累加', async () => {
    const { ownerId, ctx } = setup()
    const morning = await record(ctx, '2026-09-14T09:10:00+08:00')
    await finalize(ctx, morning, '2026-09-14T10:10:00+08:00', 320)
    const evening = await record(ctx, '2026-09-14T19:00:00+08:00', [pulldown, treadmill])
    await finalize(ctx, evening, '2026-09-14T20:00:00+08:00', 180.5, {
      overall_rpe: 7.5,
      notes: '手表记的整场：60 分钟，180 千卡，平均心率 128',
    })
    // 没填热量的那天：小字为空，但训练要在
    const other = await record(ctx, '2026-09-16T19:00:00+08:00')
    await finalize(ctx, other, '2026-09-16T20:00:00+08:00')
    await weighIn(ownerId, Date.parse('2026-09-14T22:30:00+08:00'), 63.1, 1)

    const { status, body } = await get(ownerId, SEPT)
    expect(status).toBe(200)
    expect(body.timezone).toBe('Asia/Shanghai')
    expect(body.truncated).toBe(false)
    expect(body.days.map((d: Loose) => d.date)).toEqual(['2026-09-14', '2026-09-16'])

    const day = dayOf(body, '2026-09-14')
    expect(day.calories_kcal).toBeCloseTo(500.5, 6)
    expect(day.sessions).toHaveLength(2)
    expect(day.sessions[0].calories_kcal).toBe(320)
    expect(day.sessions[0].duration_seconds).toBe(3600)
    expect(day.sessions[0].status).toBe('finalized')
    expect(day.sessions[0].entries).toHaveLength(1)
    expect(day.sessions[0].entries[0].exercise_name_raw).toBe('高位下拉')
    expect(day.sessions[0].entries[0].equipment_label).toBe('器械A')
    expect(day.sessions[0].entries[0].sets).toHaveLength(2)
    expect(day.sessions[0].entries[0].sets[0]).toMatchObject({ load_value: 45, reps: 12 })
    // 统计口径（normalized_sets）不进日历
    expect(day.sessions[0].entries[0].normalized_sets).toBeUndefined()

    expect(day.measurements).toHaveLength(1)
    expect(day.measurements[0].metrics.weight_kg).toBeCloseTo(63.1, 6)
    expect(day.measurements[0].metrics.body_fat_pct).toBe(19)
    // 派生值与报告外的推算值照常给出，界面不用自己算
    expect(day.measurements[0].metrics.fat_mass_kg).toBeCloseTo(63.1 * 0.19, 6)
    expect(day.measurements[0].metrics.bmi).toBeGreaterThan(0)

    expect(dayOf(body, '2026-09-16').calories_kcal).toBeNull()
    expect(dayOf(body, '2026-09-16').sessions).toHaveLength(1)

    // 整份响应与 tests/fixtures/calendar-response.json 逐字相同；手机端解析的单测读同一个文件，
    // 两边不会各自漂移（与 android-report.json 同一做法）。
    expect(body).toEqual(calendarFixture)
  })

  it('撤回的动作与已删除的称重不出现在日历里', async () => {
    const { ownerId, ctx } = setup()
    const receipt = await record(ctx, '2026-09-10T19:00:00+08:00')
    await amendWorkoutEntry(
      {
        idempotency_key: key(),
        expected_revision: receipt.revision,
        session_id: receipt.session_id,
        entry_id: receipt.entry_ids[0],
        raw_text: '这条记错了，撤回',
        replacement: pulldown,
        state: 'retracted',
      } as Parameters<typeof amendWorkoutEntry>[0],
      ctx,
    )
    const weighed = Date.parse('2026-09-10T22:30:00+08:00')
    await weighIn(ownerId, weighed, 63.1, 10)
    await ingestHealthConnect(
      env,
      ownerId,
      PROFILE,
      CUTOVER,
      { schema_version: '1', groups: [], deleted_hc_ids: [uuid(10)] },
      deps(noFetch, clock(NOW).now),
    )

    const { body } = await get(ownerId, SEPT)
    const day = dayOf(body, '2026-09-10')
    expect(day.sessions).toHaveLength(1)
    expect(day.sessions[0].entries).toHaveLength(0)
    expect(day.measurements).toHaveLength(0)
  })

  it('按请求时区分日，不按 UTC', async () => {
    const { ownerId, ctx } = setup()
    // 北京时间 9/15 00:30 = UTC 9/14 16:30
    const receipt = await startWorkoutSession(
      {
        idempotency_key: key(),
        expected_revision: 0,
        started_at: '2026-09-15T00:30:00+08:00',
        timezone: 'Asia/Shanghai',
        raw_text: '到健身房了',
      } as Parameters<typeof startWorkoutSession>[0],
      ctx,
    )
    await finalize(ctx, receipt.data as Loose, '2026-09-15T01:30:00+08:00', 200)

    const shanghai = await get(ownerId, SEPT)
    expect(shanghai.body.days.map((d: Loose) => d.date)).toEqual(['2026-09-15'])
    const utc = await get(ownerId, `${SEPT}&tz=UTC`)
    expect(utc.body.timezone).toBe('UTC')
    expect(utc.body.days.map((d: Loose) => d.date)).toEqual(['2026-09-14'])
  })

  it('只返回本人已发布的数据，别的 owner 看不到', async () => {
    const mine = setup()
    const theirs = setup()
    const receipt = await record(mine.ctx, '2026-09-12T19:00:00+08:00')
    await finalize(mine.ctx, receipt, '2026-09-12T20:00:00+08:00', 300)

    expect((await get(mine.ownerId, SEPT)).body.days).toHaveLength(1)
    expect((await get(theirs.ownerId, SEPT)).body.days).toHaveLength(0)
  })
})
