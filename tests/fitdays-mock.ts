import { env } from 'cloudflare:workers'
import type { SecretReader } from '../src/fitdays'
import type { Deps, ToolContext } from '../src/mcp'
import { ALL_SCOPES } from '../src/mcp'

// 全部为合成值。SYNTHETIC-SECRET 标记让仓库扫描器放行测试里的刻意样本。
export const SYNTHETIC = {
  login: 'synthetic-login-value', // SYNTHETIC-SECRET
  password: 'synthetic-password-value', // SYNTHETIC-SECRET
  token: 'tok-synthetic-0123456789abcdef', // SYNTHETIC-SECRET
  refresh: 'refresh-synthetic-0123456789abcdef', // SYNTHETIC-SECRET
  email: 'owner.synthetic@example.invalid', // SYNTHETIC-SECRET
  phone: '13800000000', // SYNTHETIC-SECRET
  openId: 'openid-synthetic-abcdef123456', // SYNTHETIC-SECRET
}

export const syntheticSecrets = (region = 'cn'): SecretReader => ({
  get: (name) =>
    name === 'FITDAYS_LOGIN' ? SYNTHETIC.login : name === 'FITDAYS_PASSWORD' ? SYNTHETIC.password : region,
})

export const loginBody = () =>
  JSON.stringify({
    code: 0,
    data: {
      token: SYNTHETIC.token,
      refresh_token: SYNTHETIC.refresh,
      account: {
        uid: 1,
        token: SYNTHETIC.token,
        email: SYNTHETIC.email,
        phone: SYNTHETIC.phone,
        open_id: SYNTHETIC.openId,
      },
    },
  })

export function weight(overrides: Record<string, unknown> = {}) {
  return {
    data_id: 'w1',
    uid: 1,
    suid: 10,
    measured_time: 1789344600,
    is_deleted: 0,
    weight_kg: 70,
    bfr: 20,
    imp_data_id: 'i1',
    balance_data_id: 'b1',
    gravity_data_id: 'g1',
    device_id: 'synthetic-device',
    ext_data: '{ "smi": 7.1, "originalImps": "500,501", "futureMetric": {"v":12} }',
    unknown_measurement: { sample: [1, null, 3] },
    ...overrides,
  }
}

/** 同步响应原文。`raw` 中的 __BIG__ 占位符替换成超出安全整数的数字词法。 */
export function syncBody(data: Record<string, unknown>): string {
  const body = {
    code: 0,
    data: {
      account: {
        uid: 1,
        token: SYNTHETIC.token,
        email: SYNTHETIC.email,
        phone: SYNTHETIC.phone,
        open_id: SYNTHETIC.openId,
      },
      ...data,
    },
  }
  return JSON.stringify(body).replace(/"__BIG__"/g, '9007199254740993')
}

export const baseData = () => ({
  weight_list: [
    weight(),
    weight({
      data_id: 'w2',
      measured_time: 1789344660,
      is_deleted: 1,
      weight_kg: 71,
      bfr: 21,
      ext_data: null,
    }),
    weight({
      data_id: 'w3',
      measured_time: 1789258200,
      weight_kg: 72,
      ext_data: '{invalid',
      imp_data_id: '',
    }),
    weight({ data_id: 'w4', measured_time: 1789258260, weight_kg: 74, big: '__BIG__' }),
  ],
  impedance_list: [
    { data_id: 'i1', suid: 10, measured_time: 1789344600, impedance: 500 },
    { data_id: 'orphan-i', suid: 10, measured_time: 1789344000, impedance: 510 },
  ],
  balance_list: [{ data_id: 'b1', suid: 10, measured_time: 1789344600, left: 49, right: 51 }],
  gravity_list: [{ data_id: 'g1', suid: 10, measured_time: 1789344600, x: 0, y: 1 }],
  hr_list: null,
  rulers_list: [],
  skip_list: [],
  devices: [
    { device_id: 'synthetic-device', model: 'fixture-only', mac: 'AA:BB:CC:DD:EE:FF', firmware_ver: '1.0' },
  ],
  users: [{ suid: 10, nickname: '测试成员', birthday: '1990-01-01', photo: 'https://example.invalid/p.png' }],
})

export interface MockUpstream {
  fetch: typeof fetch
  calls: string[]
  redirects: (string | undefined)[]
}

export function upstream(
  sync: (index: number) => string | Response | Promise<Response>,
  login: () => Response = () => new Response(loginBody()),
): MockUpstream {
  const calls: string[] = []
  const redirects: (string | undefined)[] = []
  let syncIndex = 0
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push(`${url.origin}${url.pathname}`)
    redirects.push(init?.redirect)
    if (url.pathname === '/api/users/login') return login()
    const result = await sync(syncIndex++)
    return typeof result === 'string' ? new Response(result) : result
  }
  return { fetch: fetchImpl as typeof fetch, calls, redirects }
}

export function clock(start = Date.parse('2026-09-14T12:00:00Z')) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

export function deps(fetchImpl: typeof fetch, now: () => number): Deps {
  return { fetch: fetchImpl, sleep: async () => {}, now }
}

export function toolContext(ownerId: string, d: Deps, scopes: string[] = ALL_SCOPES): ToolContext {
  return { env, ownerId, scopes: new Set(scopes), requestId: 'test-request', deps: d, waitUntil: () => {} }
}
