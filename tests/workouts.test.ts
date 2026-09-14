import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createWorker } from '../src/index'
import type { ToolContext } from '../src/mcp'
import { getTrainingTrend } from '../src/trends'
import { KtError } from '../src/util'
import {
  amendWorkoutEntry,
  finalizeWorkoutSession,
  getOpenWorkoutSessions,
  getWorkoutHistory,
  getWriteReceipt,
  recordWorkoutEvent,
  reopenWorkoutSession,
  startWorkoutSession,
} from '../src/workouts'
import { clock, deps, toolContext, upstream } from './fitdays-mock'
import { callTool, issueToken, type Loose } from './helpers'

// 时钟固定在 2026-09-14 20:00（+08:00）。
const NOW = Date.parse('2026-09-14T12:00:00Z')
const TZ = 'Asia/Shanghai'
const RANGE = { start: '2026-09-01T00:00:00+08:00', end: '2026-10-01T00:00:00+08:00' }
const at = (hhmm: string, day = '14') => `2026-09-${day}T${hhmm}:00+08:00`
const key = () => crypto.randomUUID()

const pulldown = {
  exercise_name_raw: '高位下拉',
  category: 'strength' as const,
  equipment_label: '器械A',
  sets: [
    { load_value: 45, load_unit: 'kg' as const, reps: 12 },
    { load_value: 45, load_unit: 'kg' as const, reps: 12 },
    { load_value: 45, load_unit: 'kg' as const, reps: 10 },
  ],
}
const row = {
  exercise_name_raw: '坐姿划船',
  category: 'strength' as const,
  equipment_label: '器械B',
  sets: [
    { load_value: 40, load_unit: 'kg' as const, reps: 12 },
    { load_value: 45, load_unit: 'kg' as const, reps: 10 },
  ],
}
const treadmill = {
  exercise_name_raw: '跑步机',
  category: 'cardio' as const,
  equipment_label: '测试跑步机',
  sets: [{ duration_seconds: 1200, distance_value: 3, distance_unit: 'km' as const, incline_pct: 2 }],
}

function setup(now = NOW) {
  const c = clock(now)
  const ownerId = `owner-${crypto.randomUUID()}`
  const ctx = toolContext(ownerId, deps(upstream(() => '').fetch, c.now))
  return { c, ownerId, ctx }
}

const record = (ctx: ToolContext, over: Record<string, unknown>) =>
  recordWorkoutEvent(
    {
      idempotency_key: key(),
      expected_revision: 0,
      occurred_at: at('18:20'),
      timezone: TZ,
      raw_text: '我已完成高位下拉45kg，12、12、10次',
      completion: 'completed',
      entries: [pulldown],
      ...over,
    } as Parameters<typeof recordWorkoutEvent>[0],
    ctx,
  )

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof KtError) return error.code
    throw error
  }
  throw new Error('expected rejection')
}

const count = async (table: string, ownerId: string) =>
  (
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`)
      .bind(ownerId)
      .first<{ n: number }>()
  )?.n

const history = async (ctx: ToolContext, extra: Record<string, unknown> = {}) =>
  (await getWorkoutHistory({ ...RANGE, ...extra }, ctx)).data as Loose[]

describe('训练事实：开始、多轮追加、逐组与有氧', () => {
  it('到场只建空 open 会话，不计完成事实', async () => {
    const { ctx, ownerId } = setup()
    const started = (
      await startWorkoutSession(
        {
          idempotency_key: key(),
          expected_revision: 0,
          started_at: at('18:00'),
          timezone: TZ,
          raw_text: '我到健身房了',
        },
        ctx,
      )
    ).data as Loose
    expect(started.revision).toBe(1)
    expect(started.entry_ids).toEqual([])
    expect((await getOpenWorkoutSessions({}, ctx)).data).toHaveLength(1)
    expect(await count('workout_entry_versions', ownerId)).toBe(0)
    const trend = (await getTrainingTrend({ ...RANGE, interval: 'month' }, ctx)).data as Loose
    const sessions = trend.points.find((p: Loose) => p.metric === 'sessions' && p.group_key === 'all')
    expect(sessions.value).toBe(0)
  })

  it('三条已完成汇报进入同一 open 会话；逐组不同重量、有氧字段往返不压缩', async () => {
    const { ctx } = setup()
    const first = (await record(ctx, {})).data as Loose
    expect(first.revision).toBe(1)
    const second = (
      await record(ctx, {
        expected_revision: 1,
        occurred_at: at('18:35'),
        raw_text: '刚做完坐姿划船，40kg 12次、45kg 10次',
        entries: [row],
      })
    ).data as Loose
    expect(second.session_id).toBe(first.session_id)
    const third = (
      await record(ctx, {
        session_id: first.session_id,
        expected_revision: 2,
        occurred_at: at('19:00'),
        raw_text: '跑步机已跑完20分钟，3公里，坡度2%',
        entries: [treadmill],
      })
    ).data as Loose
    expect(third.revision).toBe(3)

    const [workout] = await history(ctx)
    expect(workout.session.session_id).toBe(first.session_id)
    expect(workout.entries.map((e: Loose) => e.entry.exercise_name_raw)).toEqual([
      '高位下拉',
      '坐姿划船',
      '跑步机',
    ])
    expect(workout.entries[1].entry.sets).toEqual(row.sets)
    expect(workout.entries[1].raw_text).toBe('刚做完坐姿划船，40kg 12次、45kg 10次')
    expect(workout.entries[2].entry.sets).toEqual(treadmill.sets)
    expect(workout.entries[2].entry.normalized_sets[0].distance_m).toBe(3000)
    expect(workout.entries[0].entry.normalization_version).toBe('1')
  })

  it('未知单位与辅助负重保留原值，标准化值为 null 并带标记；lb 按 0.45359237 换算', async () => {
    const { ctx } = setup()
    const receipt = (
      await record(ctx, {
        raw_text: '辅助引体 器械格-20，8次；哑铃卧推 50 lb 做了10次',
        entries: [
          {
            exercise_name_raw: '辅助引体',
            category: 'strength',
            sets: [
              {
                load_original: { value: -20, unit: '器械格' },
                assistance_value: 20,
                assistance_unit: 'kg',
                reps: 8,
              },
            ],
          },
          {
            exercise_name_raw: '哑铃卧推',
            category: 'strength',
            sets: [{ load_value: 50, load_unit: 'lb', reps: 10 }],
          },
        ],
      })
    ).data as Loose
    const [workout] = await history(ctx)
    const [assisted, bench] = workout.entries
    expect(assisted.entry.sets[0].load_original).toEqual({ value: -20, unit: '器械格' })
    expect(assisted.entry.normalized_sets[0]).toEqual({
      load_kg: null,
      assistance_kg: 20,
      distance_m: null,
      speed_mps: null,
      quality_flags: ['unknown_load_unit'],
    })
    expect(bench.entry.normalized_sets[0].load_kg).toBe(50 * 0.45359237)
    expect(receipt.entry_ids).toHaveLength(2)
  })
})

describe('训练事实：幂等、并发与未持久化语义', () => {
  it('同键同请求重试与并发只产生一次效果；同键不同参数冲突；不同键相同内容照常保存并提示', async () => {
    const { ctx, ownerId } = setup()
    const args = {
      idempotency_key: key(),
      expected_revision: 0,
      occurred_at: at('18:20'),
      timezone: TZ,
      raw_text: '我已完成高位下拉45kg，12、12、10次',
      completion: 'completed' as const,
      entries: [pulldown],
    }
    const [a, b] = await Promise.all([recordWorkoutEvent(args, ctx), recordWorkoutEvent(args, ctx)])
    expect(a.data).toEqual(b.data)
    const again = await recordWorkoutEvent(args, ctx)
    expect(again.data).toEqual(a.data)
    expect(again.summary).toContain('未重复写入')
    expect(await count('workout_events', ownerId)).toBe(1)
    expect(await count('workout_entry_versions', ownerId)).toBe(1)

    expect(await codeOf(recordWorkoutEvent({ ...args, raw_text: '我已完成高位下拉45kg，12次' }, ctx))).toBe(
      'IDEMPOTENCY_CONFLICT',
    )
    expect(
      await codeOf(
        finalizeWorkoutSession(
          { ...args, session_id: (a.data as Loose).session_id, ended_at: at('19:00') } as Loose,
          ctx,
        ),
      ),
    ).toBe('IDEMPOTENCY_CONFLICT')

    const dup = await recordWorkoutEvent({ ...args, idempotency_key: key(), expected_revision: 1 }, ctx)
    expect(dup.summary).toContain('疑似重复')
    expect(await count('workout_entry_versions', ownerId)).toBe(2)
  })

  it('两个请求都用旧 revision：只有一个成功，另一个 REVISION_CONFLICT 且无半条记录', async () => {
    const { ctx, ownerId } = setup()
    const first = (await record(ctx, {})).data as Loose
    const results = await Promise.allSettled([
      record(ctx, {
        session_id: first.session_id,
        expected_revision: 1,
        raw_text: '做完了坐姿划船两组',
        entries: [row],
      }),
      record(ctx, {
        session_id: first.session_id,
        expected_revision: 1,
        raw_text: '跑步机跑完20分钟',
        entries: [treadmill],
      }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason.code).toBe('REVISION_CONFLICT')
    expect(rejected.reason.options.currentRevision).toBe(2)
    expect(await count('workout_entry_versions', ownerId)).toBe(2)
    expect(await count('workout_events', ownerId)).toBe(2)
  })

  it('CAS 守卫：预检查通过后被抢先提交，batch 内守卫使整笔回滚', async () => {
    const racingDb = (ctx: ToolContext, racer: () => Promise<unknown>) => {
      let raced = false
      return {
        ...ctx,
        env: {
          ...ctx.env,
          DB: new Proxy(ctx.env.DB, {
            get(target, prop) {
              if (prop === 'batch') {
                return async (statements: D1PreparedStatement[]) => {
                  if (!raced) {
                    raced = true
                    await racer()
                  }
                  return target.batch(statements)
                }
              }
              const value = Reflect.get(target, prop)
              return typeof value === 'function' ? value.bind(target) : value
            },
          }),
        },
      }
    }
    const { ctx, ownerId } = setup()
    const first = (await record(ctx, {})).data as Loose
    const racing = racingDb(ctx, () =>
      record(ctx, {
        session_id: first.session_id,
        expected_revision: 1,
        raw_text: '跑步机跑完20分钟',
        entries: [treadmill],
      }),
    )
    const error = await record(racing, {
      session_id: first.session_id,
      expected_revision: 1,
      raw_text: '做完坐姿划船两组',
      entries: [row],
    }).catch((e) => e)
    expect(error.code).toBe('REVISION_CONFLICT')
    expect(error.options.currentRevision).toBe(2)
    expect(await count('workout_entry_versions', ownerId)).toBe(2)

    const fresh = setup()
    const racingCreate = racingDb(fresh.ctx, () =>
      record(fresh.ctx, { raw_text: '做完坐姿划船两组', entries: [row] }),
    )
    const createError = await record(racingCreate, {}).catch((e) => e)
    expect(createError.code).toBe('REVISION_CONFLICT')
    expect(await count('workout_sessions', fresh.ownerId)).toBe(1)
    expect(await count('workout_events', fresh.ownerId)).toBe(1)
  })

  it('无 open 会话时并发两次首条记录：只创建一个会话', async () => {
    const { ctx, ownerId } = setup()
    const results = await Promise.allSettled([
      record(ctx, {}),
      record(ctx, { raw_text: '做完了坐姿划船两组', entries: [row] }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await count('workout_sessions', ownerId)).toBe(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason.code).toBe('REVISION_CONFLICT')
  })

  it('事务中途失败整体回滚（not_committed）；提交后响应丢失可同键查回；状态未知时明确 unknown', async () => {
    const { ctx, ownerId } = setup()
    const first = (await record(ctx, {})).data as Loose
    // 事件表里预先占用一个幂等键（无收据），使 batch 在事件插入处违反唯一约束。
    const occupied = key()
    await env.DB.prepare(
      `INSERT INTO workout_events (id, owner_id, session_id, operation, occurred_at, occurred_at_ms, local_date, raw_text,
         evidence_origin, parsed_json, schema_version, parser_version, idempotency_key, payload_hash, previous_revision,
         resulting_revision, created_at) VALUES (?, ?, ?, 'record', ?, 0, '2026-09-14', 'x', 'test', '{}', '1', 't', ?, 'h', 0, 0, 0)`,
    )
      .bind(crypto.randomUUID(), ownerId, first.session_id, at('18:00'), occupied)
      .run()
    const failed = await codeOf(
      record(ctx, {
        idempotency_key: occupied,
        session_id: first.session_id,
        expected_revision: 1,
        raw_text: '做完坐姿划船',
        entries: [row],
      }),
    )
    expect(failed).toBe('STORAGE_FAILED')
    const session = await env.DB.prepare('SELECT revision FROM workout_sessions WHERE id = ?')
      .bind(first.session_id)
      .first<Loose>()
    expect(session.revision).toBe(1)
    expect(await count('workout_entry_versions', ownerId)).toBe(1)

    // 提交成功但响应丢失：数据库已提交后抛网络错误。
    const lostKey = key()
    const lossy = {
      ...ctx,
      env: {
        ...ctx.env,
        DB: new Proxy(ctx.env.DB, {
          get(target, prop) {
            if (prop === 'batch') {
              return async (statements: D1PreparedStatement[]) => {
                await target.batch(statements)
                throw new Error('network reset after commit')
              }
            }
            const value = Reflect.get(target, prop)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
      },
    }
    const recovered = await record(lossy, {
      idempotency_key: lostKey,
      session_id: first.session_id,
      expected_revision: 1,
      raw_text: '做完坐姿划船',
      entries: [row],
    })
    expect((recovered.data as Loose).revision).toBe(2)
    expect(((await getWriteReceipt({ idempotency_key: lostKey }, ctx)).data as Loose).event_id).toBe(
      (recovered.data as Loose).event_id,
    )

    // 未提交且无法判断：不是约束错误，也查不到收据 → COMMIT_STATUS_UNKNOWN。
    const broken = {
      ...ctx,
      env: {
        ...ctx.env,
        DB: new Proxy(ctx.env.DB, {
          get(target, prop) {
            if (prop === 'batch') return async () => Promise.reject(new Error('connection dropped'))
            const value = Reflect.get(target, prop)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
      },
    }
    const unknownKey = key()
    const error = await record(broken, {
      idempotency_key: unknownKey,
      session_id: first.session_id,
      expected_revision: 2,
      raw_text: '跑步机跑完了',
      entries: [treadmill],
    }).catch((e) => e)
    expect(error.code).toBe('COMMIT_STATUS_UNKNOWN')
    expect(error.options.persistence).toBe('unknown')
    expect((await getWriteReceipt({ idempotency_key: unknownKey }, ctx)).data).toBeNull()
  })
})

describe('训练事实：计划/否定不入库、状态机与纠错', () => {
  it('计划、建议、引用他人、假设、否定、混合表达均不写入', async () => {
    const { ctx, ownerId } = setup()
    for (const raw of [
      '明天准备深蹲5×5',
      '建议做三组高位下拉',
      '朋友做了高位下拉45kg',
      '假如做完卧推就去跑步',
      '其实没做高位下拉',
      '做了两组，第三组明天做',
    ]) {
      expect(await codeOf(record(ctx, { raw_text: raw })), raw).toBe('NEEDS_CLARIFICATION')
    }
    expect(await count('workout_sessions', ownerId)).toBe(0)
    expect(await count('workout_events', ownerId)).toBe(0)
    expect(await codeOf(record(ctx, { occurred_at: at('23:59', '15') }))).toBe('INVALID_INPUT')
    expect(await codeOf(record(ctx, { entries: [{ ...pulldown, sets: [{ rpe: 8 }] }] }))).toBe(
      'INVALID_INPUT',
    )
    expect(
      await codeOf(record(ctx, { entries: [{ ...pulldown, sets: [{ load_value: 45, reps: 10 }] }] })),
    ).toBe('INVALID_UNIT')
    expect(await codeOf(record(ctx, { raw_text: '做完了，详情见 https://example.invalid/x' }))).toBe(
      'SENSITIVE_PAYLOAD_BLOCKED',
    )
    expect(await count('workout_events', ownerId)).toBe(0)
  })

  it('结束后追加被拒；显式 reopen 后可继续；结束总结可回读', async () => {
    const { ctx } = setup()
    const s = (
      await startWorkoutSession(
        {
          idempotency_key: key(),
          expected_revision: 0,
          started_at: at('18:00'),
          timezone: TZ,
          raw_text: '开始练背',
        },
        ctx,
      )
    ).data as Loose
    await record(ctx, { session_id: s.session_id, expected_revision: 1 })
    const fin = (
      await finalizeWorkoutSession(
        {
          idempotency_key: key(),
          expected_revision: 2,
          session_id: s.session_id,
          ended_at: at('19:30'),
          raw_text: '今天练完了',
          overall_rpe: 8,
          notes: '状态不错',
        },
        ctx,
      )
    ).data as Loose
    expect(fin.revision).toBe(3)
    expect(
      await codeOf(
        record(ctx, {
          session_id: s.session_id,
          expected_revision: 3,
          raw_text: '又做完一组划船',
          entries: [row],
        }),
      ),
    ).toBe('SESSION_FINALIZED')
    const [workout] = await history(ctx)
    expect(workout.session).toMatchObject({
      status: 'finalized',
      duration_seconds: 5400,
      duration_source: 'timestamps',
      overall_rpe: 8,
      notes: '状态不错',
    })
    const reopened = (
      await reopenWorkoutSession(
        { idempotency_key: key(), expected_revision: 3, session_id: s.session_id, raw_text: '继续练' },
        ctx,
      )
    ).data as Loose
    expect(reopened.revision).toBe(4)
    const more = (
      await record(ctx, {
        session_id: s.session_id,
        expected_revision: 4,
        raw_text: '又做完一组划船',
        entries: [row],
      })
    ).data as Loose
    expect(more.revision).toBe(5)
  })

  it('已结束会话中纠错：生成新版本、旧值可审计、会话仍为 finalized；撤回不计入', async () => {
    const { ctx, ownerId } = setup()
    const first = (await record(ctx, {})).data as Loose
    await finalizeWorkoutSession(
      {
        idempotency_key: key(),
        expected_revision: 1,
        session_id: first.session_id,
        ended_at: at('19:00'),
        raw_text: '练完了',
        duration_seconds: 3600,
      },
      ctx,
    )
    const corrected = {
      ...pulldown,
      sets: [{ load_value: 40, load_unit: 'kg' as const, reps: 12 }, ...pulldown.sets.slice(1)],
    }
    const amended = (
      await amendWorkoutEntry(
        {
          idempotency_key: key(),
          expected_revision: 2,
          session_id: first.session_id,
          entry_id: first.entry_ids[0],
          raw_text: '刚才第一组不是45kg，是40kg',
          replacement: corrected,
          state: 'active',
        },
        ctx,
      )
    ).data as Loose
    expect(amended.revision).toBe(3)
    const [current] = await history(ctx)
    expect(current.session.status).toBe('finalized')
    expect(current.entries).toHaveLength(1)
    expect(current.entries[0].version).toBe(2)
    expect(current.entries[0].supersedes_version).toBe(1)
    expect(current.entries[0].entry.sets.map((s: Loose) => s.load_value)).toEqual([40, 45, 45])
    const [audit] = await history(ctx, { include_superseded: true })
    expect(audit.entries.map((e: Loose) => [e.version, e.entry.sets[0].load_value, e.raw_text])).toEqual([
      [1, 45, '我已完成高位下拉45kg，12、12、10次'],
      [2, 40, '刚才第一组不是45kg，是40kg'],
    ])
    await expect(
      env.DB.prepare('DELETE FROM workout_entry_versions WHERE owner_id = ?').bind(ownerId).run(),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare("UPDATE workout_events SET raw_text = 'x' WHERE owner_id = ?").bind(ownerId).run(),
    ).rejects.toThrow()

    await amendWorkoutEntry(
      {
        idempotency_key: key(),
        expected_revision: 3,
        session_id: first.session_id,
        entry_id: first.entry_ids[0],
        raw_text: '这条记错了，其实是别的动作',
        replacement: corrected,
        state: 'retracted',
      },
      ctx,
    )
    const [afterRetract] = await history(ctx)
    expect(afterRetract.entries).toHaveLength(0)
    const trend = (await getTrainingTrend({ ...RANGE, interval: 'month' }, ctx)).data as Loose
    expect(trend.points.find((p: Loose) => p.group_key === 'all' && p.metric === 'working_sets').value).toBe(
      0,
    )
  })

  it('两个 open 需要明确选择；跨午夜保持同一会话；长时间未活动或补录昨天不能自动串场', async () => {
    const late = setup(Date.parse('2026-09-14T16:30:00Z')) // 00:30 +08:00 on 09-15
    const s = (await record(late.ctx, { occurred_at: at('23:40'), raw_text: '做完高位下拉三组' }))
      .data as Loose
    const cross = (
      await record(late.ctx, {
        expected_revision: 1,
        occurred_at: '2026-09-15T00:20:00+08:00',
        raw_text: '做完坐姿划船两组',
        entries: [row],
      })
    ).data as Loose
    expect(cross.session_id).toBe(s.session_id)
    const [workout] = await history(late.ctx)
    expect(workout.entries.map((e: Loose) => e.occurred_at.slice(0, 10))).toEqual([
      '2026-09-14',
      '2026-09-15',
    ])
    const days = (await getTrainingTrend({ ...RANGE, interval: 'month' }, late.ctx)).data as Loose
    expect(days.points.find((p: Loose) => p.group_key === 'all' && p.metric === 'training_days').value).toBe(
      2,
    )
    expect(days.points.find((p: Loose) => p.group_key === 'all' && p.metric === 'sessions').value).toBe(1)

    expect(
      await codeOf(
        record(late.ctx, {
          expected_revision: 2,
          occurred_at: at('10:00', '13'),
          raw_text: '补录：昨天做完了高位下拉',
        }),
      ),
    ).toBe('SESSION_SELECTION_REQUIRED')

    await startWorkoutSession(
      {
        idempotency_key: key(),
        expected_revision: 0,
        started_at: '2026-09-15T00:25:00+08:00',
        timezone: TZ,
        raw_text: '开始第二场',
      },
      late.ctx,
    )
    expect(
      await codeOf(record(late.ctx, { expected_revision: 2, occurred_at: '2026-09-15T00:28:00+08:00' })),
    ).toBe('SESSION_AMBIGUOUS')
    const opens = (await getOpenWorkoutSessions({}, late.ctx)).data as Loose[]
    expect(opens.every((o) => o.selection_required)).toBe(true)

    const stale = setup(NOW)
    const old = (await record(stale.ctx, { occurred_at: at('05:00') })).data as Loose
    stale.c.advance(13 * 3600_000)
    expect(await codeOf(record(stale.ctx, { expected_revision: 1, occurred_at: at('08:50', '15') }))).toBe(
      'SESSION_SELECTION_REQUIRED',
    )
    expect(((await getOpenWorkoutSessions({}, stale.ctx)).data as Loose[])[0].session_id).toBe(old.session_id)
  })

  it('条目超过单页预算时用 entry_cursor 续读同一会话，不丢组', async () => {
    const { ctx } = setup()
    const many = Array.from({ length: 15 }, (_, i) => ({ ...row, exercise_name_raw: `动作${i}` }))
    let revision = 0
    let sessionId: string | undefined
    for (let batch = 0; batch < 8; batch++) {
      const r = (
        await record(ctx, {
          session_id: sessionId,
          expected_revision: revision,
          occurred_at: at(`18:${String(batch).padStart(2, '0')}`),
          raw_text: `做完第${batch}批`,
          entries: many,
        })
      ).data as Loose
      sessionId = r.session_id
      revision = r.revision
    }
    const page = await getWorkoutHistory({ ...RANGE }, ctx)
    const [first] = page.data as Loose[]
    expect(first.entries).toHaveLength(100)
    expect(first.entries_complete).toBe(false)
    const rest = await getWorkoutHistory(
      { ...RANGE, session_id: sessionId, entry_cursor: first.entry_cursor },
      ctx,
    )
    const [second] = rest.data as Loose[]
    expect(second.entries).toHaveLength(20)
    expect(second.entries_complete).toBe(true)
    const ids = new Set([...first.entries, ...second.entries].map((e: Loose) => e.entry_id))
    expect(ids.size).toBe(120)
  })
})

describe('训练写入的鉴权边界（HTTP）', () => {
  it('只读 token 不能写；completion 非 completed 被契约拒绝；他人 token 401；错误信封含 current_revision', async () => {
    const worker = createWorker({ fetch: upstream(() => '').fetch, sleep: async () => {}, now: Date.now })
    const reader = await issueToken(worker, ['workout:read'])
    const args = {
      idempotency_key: key(),
      expected_revision: 0,
      occurred_at: new Date(Date.now() - 60_000).toISOString(),
      timezone: TZ,
      raw_text: '我已完成高位下拉45kg，12次',
      completion: 'completed',
      entries: [{ ...pulldown, sets: [pulldown.sets[0]] }],
    }
    const denied = await callTool(worker, reader.access_token, 'record_workout_event', args)
    expect(denied.structuredContent.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(denied.structuredContent.persistence).toBe('not_committed')

    const writer = await issueToken(worker, ['workout:read', 'workout:write'])
    const planned = await callTool(worker, writer.access_token, 'record_workout_event', {
      ...args,
      completion: 'planned',
    })
    expect(planned.structuredContent.error.code).toBe('INVALID_INPUT')
    const injected = await callTool(worker, writer.access_token, 'record_workout_event', {
      ...args,
      owner_id: 'someone-else',
    })
    expect(injected.structuredContent.error.code).toBe('INVALID_INPUT')

    const ok = await callTool(worker, writer.access_token, 'record_workout_event', args)
    expect(ok.structuredContent.persistence).toBe('committed')
    expect(ok.content[0].text).toContain('已保存')
    const conflict = await callTool(worker, writer.access_token, 'record_workout_event', {
      ...args,
      idempotency_key: key(),
    })
    expect(conflict.structuredContent.error).toMatchObject({
      code: 'REVISION_CONFLICT',
      current_revision: 1,
      persistence: 'not_committed',
    })

    const stranger = await issueToken(worker, ['workout:read', 'workout:write'], 'not-the-owner')
    const res = await worker.fetch(
      new Request(`${env.PUBLIC_ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${stranger.access_token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      env,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
    )
    expect(res.status).toBe(401)
  })
})
