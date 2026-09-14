import { describe, expect, it } from 'vitest'
import { fetchSyncWindows, UPSTREAM_LIMITS } from '../src/fitdays'
import { KtError } from '../src/util'
import { baseData, clock, deps, SYNTHETIC, syncBody, syntheticSecrets, upstream } from './fitdays-mock'

const WINDOW = [{ newest: 1789400000, oldest: 1780000000 }]

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof KtError) return `${error.code}:${error.options.category ?? ''}`
    throw error
  }
  throw new Error('expected rejection')
}

describe('FitDays 只读适配层', () => {
  it('只请求固定 origin 的 login 与 syncFromServer，并在 fetch text 层保留数字原文', async () => {
    const up = upstream(() => syncBody({ weight_list: [{ data_id: 'w', big: '__BIG__' }] }))
    const result = await fetchSyncWindows(syntheticSecrets(), WINDOW, deps(up.fetch, clock().now))
    expect(up.calls).toEqual([
      'https://online.fitdays.cn/api/users/login',
      'https://online.fitdays.cn/api/sync/syncFromServer',
    ])
    expect(result.windows[0]?.text).toContain('"big":9007199254740993')
    for (const secret of [
      SYNTHETIC.token,
      SYNTHETIC.refresh,
      SYNTHETIC.email,
      SYNTHETIC.phone,
      SYNTHETIC.openId,
    ]) {
      expect(result.knownSecrets.has(secret)).toBe(true)
    }
  })

  it('JSON code:302 指向其他域名：第二跳在发送前被拒绝', async () => {
    const up = upstream(() => JSON.stringify({ code: 302, data: { domain: 'https://not-allowed.invalid' } }))
    expect(await codeOf(fetchSyncWindows(syntheticSecrets(), WINDOW, deps(up.fetch, clock().now)))).toBe(
      'UPSTREAM_ROUTE_DENIED:route_not_allowed',
    )
    expect(up.calls.filter((c) => c.includes('syncFromServer'))).toHaveLength(1)
  })

  it('同域 JSON 302 循环受跳数上限约束', async () => {
    const up = upstream(() => JSON.stringify({ code: 302, data: { domain: 'https://online.fitdays.cn' } }))
    expect(await codeOf(fetchSyncWindows(syntheticSecrets(), WINDOW, deps(up.fetch, clock().now)))).toBe(
      'UPSTREAM_ROUTE_DENIED:hop_limit',
    )
    expect(up.calls.filter((c) => c.includes('syncFromServer'))).toHaveLength(
      UPSTREAM_LIMITS.maxCallsPerRequest,
    )
  })

  it('HTTP 3xx 不跟随', async () => {
    const up = upstream(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid/' } }),
    )
    expect(await codeOf(fetchSyncWindows(syntheticSecrets(), WINDOW, deps(up.fetch, clock().now)))).toBe(
      'UPSTREAM_ROUTE_DENIED:http_redirect',
    )
  })

  it('网络失败有限重试后返回 UPSTREAM_TIMEOUT', async () => {
    let attempts = 0
    const up = upstream(async () => {
      attempts++
      throw new TypeError('network down')
    })
    expect(await codeOf(fetchSyncWindows(syntheticSecrets(), WINDOW, deps(up.fetch, clock().now)))).toBe(
      'UPSTREAM_TIMEOUT:network_or_timeout',
    )
    expect(attempts).toBe(UPSTREAM_LIMITS.retries + 1)
  })

  it('超过字节预算的响应被拒绝', async () => {
    const original = UPSTREAM_LIMITS.maxResponseBytes
    UPSTREAM_LIMITS.maxResponseBytes = 1024
    try {
      const up = upstream(() => syncBody({ weight_list: [{ pad: 'x'.repeat(4096) }] }))
      expect(await codeOf(fetchSyncWindows(syntheticSecrets(), WINDOW, deps(up.fetch, clock().now)))).toBe(
        'INCOMPLETE_SYNC:response_too_large',
      )
    } finally {
      UPSTREAM_LIMITS.maxResponseBytes = original
    }
  })

  it('登录失败、凭据缺失、区域非法均为 FITDAYS_LOGIN_FAILED，且不带上游响应', async () => {
    const failing = upstream(
      () => syncBody(baseData()),
      () => new Response(JSON.stringify({ code: 1001, msg: `bad ${SYNTHETIC.email}` })),
    )
    const error = await fetchSyncWindows(syntheticSecrets(), WINDOW, deps(failing.fetch, clock().now)).catch(
      (e) => e,
    )
    expect(error).toBeInstanceOf(KtError)
    expect(error.code).toBe('FITDAYS_LOGIN_FAILED')
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(SYNTHETIC.email)
    const up = upstream(() => '')
    expect(
      await codeOf(fetchSyncWindows({ get: () => undefined }, WINDOW, deps(up.fetch, clock().now))),
    ).toBe('FITDAYS_LOGIN_FAILED:secret_missing')
    expect(
      await codeOf(fetchSyncWindows(syntheticSecrets('mars'), WINDOW, deps(up.fetch, clock().now))),
    ).toBe('FITDAYS_LOGIN_FAILED:region_invalid')
    expect(up.calls).toHaveLength(0)
  })
})
