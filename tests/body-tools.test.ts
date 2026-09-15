import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorker } from '../src/index'
import { requestRefresh, runSyncJob } from '../src/sync'
import { baseData, clock, SYNTHETIC, syncBody, upstream, weight } from './fitdays-mock'
import { callTool, issueToken } from './helpers'

describe('体测工具经 HTTP/OAuth 调用', () => {
  afterEach(() => vi.restoreAllMocks())

  it('读工具只读镜像、不访问上游；发布后不 stale，最近一次同步失败后标 stale，日志无秘密', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)))
    const c = clock(Date.now())
    let failUpstream = false
    const up = upstream(() => {
      if (failUpstream) return new Response(JSON.stringify({ code: 500, msg: `oops ${SYNTHETIC.token}` }))
      return syncBody({
        ...baseData(),
        weight_list: [weight({ measured_time: Math.floor(c.now() / 1000) - 3600 })],
      })
    })
    const d = { fetch: up.fetch, sleep: async () => {}, now: c.now }
    const worker = createWorker(d)
    const reader = await issueToken(worker, ['body:read'])

    const empty = await callTool(worker, reader.access_token, 'get_latest_measurement_full', {})
    expect(empty.structuredContent.status).toBe('empty')
    expect(empty.structuredContent.stale).toBe(true)
    expect(up.calls).toHaveLength(0) // 读工具不触发上游访问

    // refresh_data 已下线（体测改由手机推送）；早期 FitDays 同步链路仍由内部任务驱动。
    const job = await requestRefresh(env.DB, env.OWNER_ID, 'incremental', c.now())
    await runSyncJob(env, job.job_id, d)
    const status = await callTool(worker, reader.access_token, 'get_sync_status', {})
    expect(status.structuredContent.data.state).toBe('published')
    const latest = await callTool(worker, reader.access_token, 'get_latest_measurement_full', {})
    expect(latest.structuredContent.status).toBe('ok')
    expect(latest.structuredContent.stale).toBe(false)
    expect(latest.structuredContent.data.weight.raw_json).toContain('"weight_kg":70')

    c.advance(24 * 3600_000 + 1)
    failUpstream = true
    const failing = await requestRefresh(env.DB, env.OWNER_ID, 'full', c.now())
    await runSyncJob(env, failing.job_id, d)
    const after = await callTool(worker, reader.access_token, 'get_latest_measurement_full', {})
    expect(after.structuredContent.stale).toBe(true)
    expect(after.structuredContent.data.weight.raw_json).toContain('"weight_kg":70')
    const failed = await callTool(worker, reader.access_token, 'get_sync_status', {})
    expect(failed.structuredContent.data.error_code).toBe('INCOMPLETE_SYNC')

    const joined = logs.join('\n')
    expect(joined).toContain('"event":"sync"')
    for (const secret of Object.values(SYNTHETIC)) expect(joined).not.toContain(secret)
    expect(joined).not.toContain('oops')
  })

  it('非法输入、无效范围在服务端拒绝', async () => {
    const worker = createWorker({ fetch: upstream(() => '').fetch, sleep: async () => {}, now: Date.now })
    const { access_token } = await issueToken(worker, ['body:read'])
    const bad = await callTool(worker, access_token, 'get_raw_dataset', {
      dataset: 'account',
      start: '2026-09-01T00:00:00+08:00',
      end: '2026-09-02T00:00:00+08:00',
    })
    expect(bad.structuredContent.error.code).toBe('INVALID_INPUT')
    const reversed = await callTool(worker, access_token, 'get_measurements', {
      start: '2026-09-02T00:00:00+08:00',
      end: '2026-09-01T00:00:00+08:00',
    })
    expect(reversed.structuredContent.error.code).toBe('INVALID_RANGE')
    const tooLong = await callTool(worker, access_token, 'get_measurements', {
      start: '2020-01-01T00:00:00+08:00',
      end: '2026-09-01T00:00:00+08:00',
    })
    expect(tooLong.structuredContent.error.code).toBe('INVALID_RANGE')
    const fullTooMany = await callTool(worker, access_token, 'get_measurements', {
      start: '2026-09-01T00:00:00+08:00',
      end: '2026-09-02T00:00:00+08:00',
      detail: 'full',
      limit: 100,
    })
    expect(fullTooMany.structuredContent.error.code).toBe('INVALID_INPUT')
  })
})
