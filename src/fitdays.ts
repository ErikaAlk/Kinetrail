// FitDays 只读适配层。唯一允许的上游请求：固定 origin 下的 login 与 syncFromServer。
// 签名/密码摘要/JSON 302 逻辑复用 fitdays-api 的公共 request()；原文在 fetch text 层捕获，避免 JSON.parse 丢精度。
// 登录结果、token、等价密码摘要只在本函数调用期间的内存里。

import { FitDaysApiError, FitDaysClient, hashPassword } from 'fitdays-api'
import type { Deps } from './mcp'
import { isCredentialKey } from './sanitize'
import { KtError, parseLossless } from './util'

export const REGION_ORIGINS = {
  cn: 'https://online.fitdays.cn',
  eu: 'https://online-eu.fitdays.cn',
  us: 'https://online-us.fitdays.cn',
} as const
export type Region = keyof typeof REGION_ORIGINS

const LOGIN_PATH = '/api/users/login'
const SYNC_PATH = '/api/sync/syncFromServer'
const ALLOWED_PATHS = new Set([LOGIN_PATH, SYNC_PATH])

// ponytail: 以下预算是真机 G1/G2 前的候选值，需按真实响应大小与耗时校准。
export const UPSTREAM_LIMITS = {
  requestTimeoutMs: 15_000,
  jobDeadlineMs: 120_000,
  maxCallsPerRequest: 3,
  maxResponseBytes: 32 * 1024 * 1024,
  retries: 2,
  backoffMs: [1_000, 3_000],
}

export type SecretName = 'FITDAYS_LOGIN' | 'FITDAYS_PASSWORD' | 'FITDAYS_REGION'
export interface SecretReader {
  get(name: SecretName): string | undefined
}
export const envSecrets = (env: Env): SecretReader => ({ get: (name) => env[name] })

export const fitdaysConfigured = (secrets: SecretReader) =>
  Boolean(secrets.get('FITDAYS_LOGIN') && secrets.get('FITDAYS_PASSWORD'))

export interface SyncWindow {
  /** unix 秒。上游约定 start_time=最新，end_time=最旧。 */
  newest: number
  oldest: number
}

export interface CapturedWindow {
  window: SyncWindow
  text: string
}

export interface FetchResult {
  region: Region
  windows: CapturedWindow[]
  /** 本次登录得到的秘密值，仅用于采集时精确匹配阻断；调用方用完即丢。 */
  knownSecrets: Set<string>
}

async function readLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new KtError('INCOMPLETE_SYNC', { category: 'response_too_large' })
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
}

/** 从登录/同步响应里收集账户秘密值（token、邮箱、手机号等），供采集时精确匹配。 */
export function collectSecretValues(value: unknown, into: Set<string>, underSecretKey = false): void {
  if (typeof value === 'string') {
    if (underSecretKey && value.length >= 4) into.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSecretValues(item, into, underSecretKey)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      collectSecretValues(item, into, underSecretKey || isCredentialKey(key))
    }
  }
}

export async function fetchSyncWindows(
  secrets: SecretReader,
  windows: SyncWindow[],
  deps: Deps,
): Promise<FetchResult> {
  const login = secrets.get('FITDAYS_LOGIN')
  const password = secrets.get('FITDAYS_PASSWORD')
  const region = (secrets.get('FITDAYS_REGION') ?? 'cn') as Region
  if (!login || !password) throw new KtError('FITDAYS_LOGIN_FAILED', { category: 'secret_missing' })
  if (!(region in REGION_ORIGINS)) throw new KtError('FITDAYS_LOGIN_FAILED', { category: 'region_invalid' })
  const origin = REGION_ORIGINS[region]
  const deadline = deps.now() + UPSTREAM_LIMITS.jobDeadlineMs
  const knownSecrets = new Set<string>([login, password, hashPassword(password)])

  let calls = 0
  const capture: { text: string | null } = { text: null }
  const guardedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    // 路由白名单先于任何网络发送：JSON 302 指向其他域名时第二跳在这里被拒绝。
    if (url.protocol !== 'https:' || url.origin !== origin || !ALLOWED_PATHS.has(url.pathname)) {
      throw new KtError('UPSTREAM_ROUTE_DENIED', { category: 'route_not_allowed' })
    }
    if (++calls > UPSTREAM_LIMITS.maxCallsPerRequest) {
      throw new KtError('UPSTREAM_ROUTE_DENIED', { category: 'hop_limit' })
    }
    const remaining = deadline - deps.now()
    if (remaining <= 0) throw new KtError('UPSTREAM_TIMEOUT', { category: 'job_deadline' })
    let response: Response
    try {
      response = await deps.fetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(UPSTREAM_LIMITS.requestTimeoutMs, remaining)),
      })
    } catch {
      throw new KtError('UPSTREAM_TIMEOUT', { retryable: true, category: 'network_or_timeout' })
    }
    if (response.status >= 300 && response.status < 400) {
      throw new KtError('UPSTREAM_ROUTE_DENIED', { category: 'http_redirect' })
    }
    const text = await readLimited(response, UPSTREAM_LIMITS.maxResponseBytes)
    capture.text = text
    return new Response(text, { status: response.status, headers: { 'content-type': 'application/json' } })
  }

  const client = new FitDaysClient({ region, fetchImpl: guardedFetch as typeof fetch })

  async function attempt<T>(
    fn: () => Promise<T>,
    failure: 'FITDAYS_LOGIN_FAILED' | 'INCOMPLETE_SYNC',
  ): Promise<T> {
    for (let i = 0; ; i++) {
      calls = 0
      capture.text = null
      try {
        return await fn()
      } catch (error) {
        if (error instanceof KtError) {
          if (error.options.retryable && i < UPSTREAM_LIMITS.retries && deps.now() < deadline) {
            await deps.sleep(UPSTREAM_LIMITS.backoffMs[i] ?? 3_000)
            continue
          }
          throw error
        }
        // FitDaysApiError 携带完整上游响应；只保留数值 code 作为非敏感类别。
        const category =
          error instanceof FitDaysApiError ? `upstream_code_${Number(error.code) || 0}` : 'client_error'
        throw new KtError(failure, { category })
      }
    }
  }

  const session = await attempt(() => client.login(login, password), 'FITDAYS_LOGIN_FAILED')
  knownSecrets.add(session.token)
  if (session.refreshToken) knownSecrets.add(session.refreshToken)
  try {
    if (capture.text) collectSecretValues(parseLossless(capture.text), knownSecrets)
  } catch {
    // 登录响应已被 SDK 成功解析；这里只是尽量多收集秘密值。
  }
  capture.text = null

  const out: CapturedWindow[] = []
  for (const window of windows) {
    await attempt(
      () => client.request(SYNC_PATH.slice(1), { start_time: window.newest, end_time: window.oldest }),
      'INCOMPLETE_SYNC',
    )
    if (capture.text === null) throw new KtError('INCOMPLETE_SYNC', { category: 'capture_missing' })
    out.push({ window, text: capture.text })
    capture.text = null
  }
  return { region, windows: out, knownSecrets }
}
