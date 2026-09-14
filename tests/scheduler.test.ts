import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { SCHEDULER_INTERVAL_MS, type SyncScheduler } from '../src/index'

const alarmOf = (stub: DurableObjectStub<SyncScheduler>) =>
  runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())

// 本文件的定时任务不能碰 FitDays：把 owner 的同步标记为刚执行过，scheduledSync 只做补偿检查就返回。
async function markSyncFresh() {
  const now = Date.now()
  await env.DB.prepare(
    'INSERT OR REPLACE INTO sync_meta (owner_id, last_attempt_at, last_full_at) VALUES (?, ?, ?)',
  )
    .bind(env.OWNER_ID, now, now)
    .run()
}

describe('SyncScheduler（替代不投递的 cron）', () => {
  it('ensure 只补缺失的 alarm，不推迟已有的，也不立即执行', async () => {
    const stub = env.SYNC_SCHEDULER.getByName('ensure-test')
    const before = Date.now()
    await stub.ensure()
    const first = await alarmOf(stub)
    expect(first).toBeGreaterThanOrEqual(before + SCHEDULER_INTERVAL_MS)
    await stub.ensure()
    expect(await alarmOf(stub)).toBe(first)
  })

  it('alarm 执行定时任务并续约；任务抛错时仍续约', async () => {
    await markSyncFresh()
    await env.DB.prepare(
      "INSERT INTO auth_pending (id, kind, cookie_hash, payload_json, expires_at) VALUES ('stale', 'consent', 'h', '{}', ?)",
    )
      .bind(Date.now() - 1000)
      .run()
    const stub = env.SYNC_SCHEDULER.getByName('alarm-test')
    await stub.ensure()

    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_pending WHERE id = 'stale'").first<{
      n: number
    }>()
    expect(pending?.n).toBe(0)
    expect(await alarmOf(stub)).toBeGreaterThan(Date.now())

    await env.DB.prepare('ALTER TABLE rate_limits RENAME TO rate_limits_hidden').run()
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true)
      expect(await alarmOf(stub)).toBeGreaterThan(Date.now())
    } finally {
      await env.DB.prepare('ALTER TABLE rate_limits_hidden RENAME TO rate_limits').run()
    }
  })
})
