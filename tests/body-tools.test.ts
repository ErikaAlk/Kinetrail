import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorker } from '../src/index'
import { baseData, clock, SYNTHETIC, syncBody, upstream, weight } from './fitdays-mock'
import { callTool, issueToken } from './helpers'

describe('体测工具经 HTTP/OAuth 调用', () => {
  afterEach(() => vi.restoreAllMocks())

  it('refresh_data 需要 body:sync；排队后执行，读工具返回镜像，上游失败后标 stale 且日志无秘密', async () => {
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
    const worker = createWorker({ fetch: up.fetch, sleep: async () => {}, now: c.now })

    const reader = await issueToken(worker, ['body:read'])
    const denied = await callTool(worker, reader.access_token, 'refresh_data', {})
    expect(denied.structuredContent.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(up.calls).toHaveLength(0)

    const empty = await callTool(worker, reader.access_token, 'get_latest_measurement_full', {})
    expect(empty.structuredContent.status).toBe('empty')
    expect(empty.structuredContent.stale).toBe(true)
    expect(up.calls).toHaveLength(0) // 读工具不触发上游访问

    const syncer = await issueToken(worker, ['body:read', 'body:sync'])
    const job = await callTool(worker, syncer.access_token, 'refresh_data', { mode: 'incremental' })
    expect(job.structuredContent.persistence).toBe('committed')
    expect(job.structuredContent.data.state).toBe('queued')

    const status = await callTool(worker, reader.access_token, 'get_sync_status', {})
    expect(status.structuredContent.data.state).toBe('published')
    const latest = await callTool(worker, reader.access_token, 'get_latest_measurement_full', {})
    expect(latest.structuredContent.status).toBe('ok')
    expect(latest.structuredContent.stale).toBe(false)
    expect(latest.structuredContent.data.weight.raw_json).toContain('"weight_kg":70')

    c.advance(24 * 3600_000 + 1)
    failUpstream = true
    await callTool(worker, syncer.access_token, 'refresh_data', { mode: 'full' })
    const after = await callTool(worker, reader.access_token, 'get_latest_measurement_full', {})
    expect(after.structuredContent.stale).toBe(true)
    expect(after.structuredContent.data.weight.raw_json).toContain('"weight_kg":70')
    const failed = await callTool(worker, reader.access_token, 'get_sync_status', {})
    expect(failed.structuredContent.data.error_code).toBe('INCOMPLETE_SYNC')

    const cooldown = await callTool(worker, syncer.access_token, 'refresh_data', { mode: 'full' })
    expect(cooldown.structuredContent.error.code).toBe('SYNC_IN_PROGRESS')
    expect(cooldown.structuredContent.error.retry_after_seconds).toBeGreaterThan(0)
    expect(cooldown.content[0].text).toContain('本次未持久化')

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
