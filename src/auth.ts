// 授权页：/authorize → Cloudflare Access (OIDC) 本人登录 → /callback 验签与本人绑定 → 明确 consent → Provider 签发。
// 一次性状态放 D1（DELETE ... RETURNING），浏览器绑定用 __Host- cookie，consent 表单另带 CSRF token 并校验 Origin。
// Access 的 token 只在本次请求内用于确认身份，不进入 MCP、不落库。

import type { AuthRequest } from '@cloudflare/workers-oauth-provider'
import type { Deps } from './mcp'
import { resourceUrl } from './mcp'
import { consumeRateLimit } from './ratelimit'
import {
  b64url,
  constantTimeEqual,
  encoder,
  fromB64url,
  KtError,
  logEvent,
  randomToken,
  sha256Hex,
} from './util'

const COOKIE = '__Host-kt_auth'
const AUTHORIZE_TTL_MS = 10 * 60_000
const CONSENT_TTL_MS = 5 * 60_000
const CLOCK_SKEW_S = 60
const UPSTREAM_TIMEOUT_MS = 10_000
const SUPPORTED_SCOPES = ['body:read', 'body:sync', 'workout:read', 'workout:write']
const DEFAULT_SCOPES = ['body:read', 'workout:read']
const SCOPE_LABELS: Record<string, string> = {
  'body:read': '读取体测数据与同步状态',
  'body:sync': '从 FitDays 只读拉取并更新 Kinetrail 镜像（不会修改 FitDays）',
  'workout:read': '读取训练记录与趋势',
  'workout:write': '写入你确认已完成的训练、结束/重开会话、版本化纠错（不物理删除）',
}

// ───────────── 响应 ─────────────
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
}

function page(status: number, title: string, body: string, extra: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b}ul{padding-left:1.2rem}button{font:inherit;padding:.5rem 1.2rem;margin-right:.6rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      ...SECURITY_HEADERS,
      ...extra,
    },
  })
}

const failure = (status: number, message: string) =>
  page(status, '无法完成授权', `<p>${escapeHtml(message)}</p>`)

function cookieValue(request: Request): string | null {
  const header = request.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE) return rest.join('=')
  }
  return null
}

const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'unknown'

function oidcConfig(env: Env) {
  const config = {
    issuer: env.ACCESS_OIDC_ISSUER,
    authorization: env.ACCESS_OIDC_AUTHORIZATION_ENDPOINT,
    token: env.ACCESS_OIDC_TOKEN_ENDPOINT,
    jwks: env.ACCESS_OIDC_JWKS_URL,
    clientId: env.ACCESS_CLIENT_ID,
    clientSecret: env.ACCESS_CLIENT_SECRET,
  }
  const urls = [config.authorization, config.token, config.jwks]
  const complete = Object.values(config).every(Boolean) && urls.every((u) => u.startsWith('https://'))
  // OWNER_OIDC_SUB 为空时进入“绑定模式”：只显示当前登录身份的 sub，永不签发授权。
  return complete
    ? { ...(config as { [K in keyof typeof config]: string }), ownerSub: env.OWNER_OIDC_SUB ?? '' }
    : null
}

// ───────────── 一次性状态 ─────────────
interface Pending<T> {
  cookie_hash: string
  payload_json: string
  expires_at: number
  payload: T
}

async function consumePending<T>(db: D1Database, id: string, kind: 'authorize' | 'consent', nowMs: number) {
  const row = await db
    .prepare(
      'DELETE FROM auth_pending WHERE id = ? AND kind = ? RETURNING cookie_hash, payload_json, expires_at',
    )
    .bind(id, kind)
    .first<Omit<Pending<T>, 'payload'>>()
  if (!row || row.expires_at < nowMs) return null
  return { ...row, payload: JSON.parse(row.payload_json) as T }
}

export const purgeAuthPending = (db: D1Database, nowMs: number) =>
  db.prepare('DELETE FROM auth_pending WHERE expires_at < ?').bind(nowMs).run()

function errorRedirect(env: Env, oauthReq: AuthRequest, error: string, description: string): Response {
  const target = new URL(oauthReq.redirectUri)
  target.searchParams.set('error', error)
  target.searchParams.set('error_description', description)
  if (oauthReq.state) target.searchParams.set('state', oauthReq.state)
  target.searchParams.set('iss', env.PUBLIC_ORIGIN)
  return new Response(null, { status: 302, headers: { location: target.toString(), ...SECURITY_HEADERS } })
}

// ───────────── JWT (RS256) ─────────────
interface Jwk extends JsonWebKey {
  kid?: string
}
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>()

async function fetchWithTimeout(deps: Deps, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await deps.fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    throw new KtError('AUTH_REQUIRED', { category: 'oidc_upstream_unreachable' })
  }
}

async function jwks(url: string, deps: Deps, force: boolean): Promise<Jwk[]> {
  const cached = jwksCache.get(url)
  if (!force && cached && deps.now() - cached.fetchedAt < 10 * 60_000) return cached.keys
  const response = await fetchWithTimeout(deps, url)
  if (!response.ok) throw new KtError('AUTH_REQUIRED', { category: 'jwks_fetch_failed' })
  const body = (await response.json()) as { keys?: Jwk[] }
  const keys = Array.isArray(body.keys) ? body.keys : []
  jwksCache.set(url, { keys, fetchedAt: deps.now() })
  return keys
}

export interface IdClaims {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  iat?: number
  nbf?: number
  nonce?: string
  azp?: string
}

const decodePart = <T>(part: string): T => JSON.parse(new TextDecoder().decode(fromB64url(part))) as T

export async function verifyIdToken(
  token: string,
  expected: { issuer: string; audience: string; jwksUrl: string; nonce: string },
  deps: Deps,
): Promise<IdClaims> {
  const invalid = (category: string) => new KtError('AUTH_REQUIRED', { category })
  const parts = token.split('.')
  if (parts.length !== 3) throw invalid('id_token_format')
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
  let header: { alg?: string; kid?: string }
  let claims: IdClaims
  try {
    header = decodePart(headerPart)
    claims = decodePart(payloadPart)
  } catch {
    throw invalid('id_token_decode')
  }
  if (header.alg !== 'RS256') throw invalid('id_token_alg')
  let jwk = (await jwks(expected.jwksUrl, deps, false)).find((k) => k.kty === 'RSA' && k.kid === header.kid)
  jwk ??= (await jwks(expected.jwksUrl, deps, true)).find((k) => k.kty === 'RSA' && k.kid === header.kid)
  if (!jwk) throw invalid('id_token_kid')
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true } as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    fromB64url(signaturePart),
    encoder.encode(`${headerPart}.${payloadPart}`),
  )
  if (!valid) throw invalid('id_token_signature')
  const now = Math.floor(deps.now() / 1000)
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== expected.issuer) throw invalid('id_token_iss')
  if (!audiences.includes(expected.audience)) throw invalid('id_token_aud')
  if (audiences.length > 1 && claims.azp !== expected.audience) throw invalid('id_token_azp')
  if (typeof claims.exp !== 'number' || claims.exp < now - CLOCK_SKEW_S) throw invalid('id_token_expired')
  if (typeof claims.iat === 'number' && claims.iat > now + CLOCK_SKEW_S) throw invalid('id_token_iat')
  if (typeof claims.nbf === 'number' && claims.nbf > now + CLOCK_SKEW_S) throw invalid('id_token_nbf')
  if (!claims.nonce || !constantTimeEqual(claims.nonce, expected.nonce)) throw invalid('id_token_nonce')
  if (typeof claims.sub !== 'string' || !claims.sub) throw invalid('id_token_sub')
  return claims
}

// ───────────── 路由 ─────────────
interface AuthorizePayload {
  oauthReq: AuthRequest
  scopes: string[]
  nonce: string
  verifier: string
}
interface ConsentPayload {
  oauthReq: AuthRequest
  scopes: string[]
  csrf: string
}

export async function handleAuthRoutes(request: Request, env: Env, deps: Deps): Promise<Response | null> {
  const url = new URL(request.url)
  const route = `${request.method} ${url.pathname}`
  if (!['GET /authorize', 'GET /callback', 'POST /consent'].includes(route)) return null
  try {
    const limits: Record<string, number> = { 'GET /authorize': 10, 'GET /callback': 20, 'POST /consent': 20 }
    await consumeRateLimit(
      env.DB,
      `${url.pathname}:${clientIp(request)}`,
      limits[route] ?? 10,
      60,
      deps.now(),
    )
    const config = oidcConfig(env)
    if (!config) return failure(503, '身份提供方尚未配置。')
    if (route === 'GET /authorize') return await authorize(request, env, config, deps)
    if (route === 'GET /callback') return await callback(request, env, config, deps)
    return await consent(request, env, deps)
  } catch (error) {
    if (error instanceof KtError && error.code === 'RATE_LIMITED') {
      return page(429, '请求过于频繁', '<p>请稍后再试。</p>', {
        'retry-after': String(error.options.retryAfterSeconds ?? 60),
      })
    }
    const category =
      error instanceof KtError ? error.options.category : error instanceof Error ? error.name : 'unknown'
    logEvent({
      event: 'auth',
      status: 'error',
      code: error instanceof KtError ? error.code : 'AUTH_REQUIRED',
      ...(category ? { category } : {}),
    })
    return failure(400, '授权请求无效或已过期，请回到 ChatGPT 重新连接。')
  }
}

async function authorize(
  request: Request,
  env: Env,
  config: NonNullable<ReturnType<typeof oidcConfig>>,
  deps: Deps,
): Promise<Response> {
  let oauthReq: AuthRequest
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request)
  } catch {
    // 客户端或回调地址未通过校验：不能重定向到不可信地址，只显示错误页。
    return failure(400, '客户端或回调地址无效。')
  }
  if (
    oauthReq.responseType !== 'code' ||
    !oauthReq.codeChallenge ||
    oauthReq.codeChallengeMethod !== 'S256'
  ) {
    return errorRedirect(env, oauthReq, 'invalid_request', 'PKCE S256 is required')
  }
  const resources = oauthReq.resource === undefined ? [] : [oauthReq.resource].flat()
  if (resources.some((r) => r !== resourceUrl(env))) {
    return errorRedirect(env, oauthReq, 'invalid_target', 'Unknown resource')
  }
  const requested = oauthReq.scope.length > 0 ? oauthReq.scope : DEFAULT_SCOPES
  if (requested.some((s) => !SUPPORTED_SCOPES.includes(s))) {
    return errorRedirect(env, oauthReq, 'invalid_scope', 'Unsupported scope')
  }

  const id = randomToken()
  const cookie = randomToken()
  const verifier = randomToken(32)
  const payload: AuthorizePayload = {
    oauthReq,
    scopes: [...new Set(requested)],
    nonce: randomToken(),
    verifier,
  }
  await env.DB.prepare(
    'INSERT INTO auth_pending (id, kind, cookie_hash, payload_json, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, 'authorize', await sha256Hex(cookie), JSON.stringify(payload), deps.now() + AUTHORIZE_TTL_MS)
    .run()
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))))
  const target = new URL(config.authorization)
  target.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${env.PUBLIC_ORIGIN}/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state: id,
    nonce: payload.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      'set-cookie': `${COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${AUTHORIZE_TTL_MS / 1000}`,
      ...SECURITY_HEADERS,
    },
  })
}

async function callback(
  request: Request,
  env: Env,
  config: NonNullable<ReturnType<typeof oidcConfig>>,
  deps: Deps,
): Promise<Response> {
  const url = new URL(request.url)
  const state = url.searchParams.get('state') ?? ''
  const cookie = cookieValue(request)
  const pending = state
    ? await consumePending<AuthorizePayload>(env.DB, state, 'authorize', deps.now())
    : null
  if (!pending || !cookie || !constantTimeEqual(pending.cookie_hash, await sha256Hex(cookie))) {
    return failure(400, '授权会话无效或已过期，请回到 ChatGPT 重新连接。')
  }
  const { oauthReq } = pending.payload
  if (url.searchParams.get('error'))
    return errorRedirect(env, oauthReq, 'access_denied', 'Sign-in was not completed')
  const code = url.searchParams.get('code')
  if (!code) return failure(400, '缺少授权码。')

  const tokenResponse = await fetchWithTimeout(deps, config.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${env.PUBLIC_ORIGIN}/callback`,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: pending.payload.verifier,
    }),
  })
  if (!tokenResponse.ok) throw new KtError('AUTH_REQUIRED', { category: 'oidc_token_exchange' })
  const tokens = (await tokenResponse.json().catch(() => ({}))) as { id_token?: string }
  if (!tokens.id_token) throw new KtError('AUTH_REQUIRED', { category: 'oidc_no_id_token' })
  const claims = await verifyIdToken(
    tokens.id_token,
    { issuer: config.issuer, audience: config.clientId, jwksUrl: config.jwks, nonce: pending.payload.nonce },
    deps,
  )
  if (!config.ownerSub) {
    // 首次部署绑定：登录者只能看到自己的 sub，用于设置 OWNER_OIDC_SUB；不创建 consent、不签发任何 token。
    logEvent({ event: 'auth', status: 'denied', code: 'AUTH_REQUIRED', category: 'owner_not_bound' })
    return page(
      403,
      'Kinetrail 尚未绑定本人身份',
      `<p>当前登录身份的 sub：</p><p><code>${escapeHtml(claims.sub)}</code></p><p>确认这是你本人后，把它设置为 <code>OWNER_OIDC_SUB</code> 并重新部署。设置前任何客户端都无法获得授权。</p>`,
    )
  }
  // 本人白名单：固定 (issuer, sub)。不使用 email 或模型提供的任何身份字段。
  if (claims.iss !== config.issuer || !constantTimeEqual(claims.sub, config.ownerSub)) {
    logEvent({ event: 'auth', status: 'denied', code: 'AUTH_REQUIRED', category: 'not_owner' })
    return failure(403, '当前登录的身份无权连接 Kinetrail。')
  }

  const consentId = randomToken()
  const csrf = randomToken()
  const payload: ConsentPayload = { oauthReq, scopes: pending.payload.scopes, csrf }
  await env.DB.prepare(
    'INSERT INTO auth_pending (id, kind, cookie_hash, payload_json, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(consentId, 'consent', pending.cookie_hash, JSON.stringify(payload), deps.now() + CONSENT_TTL_MS)
    .run()

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId)
  const clientName = client?.clientName ?? oauthReq.clientId
  const redirect = new URL(oauthReq.redirectUri)
  const scopes = payload.scopes
    .map((s) => `<li><code>${escapeHtml(s)}</code>：${escapeHtml(SCOPE_LABELS[s] ?? s)}</li>`)
    .join('')
  // 客户端名称由客户端自己声明（CIMD 下任何人都能填），只作参考；真正需要核对的是回调地址。
  const body = `<p>有客户端请求连接你的 Kinetrail（身迹）数据。</p>
<p>授权后将跳转到：<strong><code>${escapeHtml(redirect.origin)}</code></strong>（请确认这是 ChatGPT 或你信任的地址）</p>
<p>客户端自报名称：${escapeHtml(clientName)}</p>
<p>将授予以下权限：</p><ul>${scopes}</ul>
<p>Kinetrail 对 FitDays 始终只读；训练写入只影响 Kinetrail 自己的数据库。</p>
<form method="post" action="/consent">
<input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit" name="decision" value="approve">授权</button>
<button type="submit" name="decision" value="deny">拒绝</button>
</form>`
  return page(200, '授权连接 Kinetrail', body, {
    // 表单提交后的 302 需要目标回调 origin 在 form-action 白名单中。
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirect.origin}; frame-ancestors 'none'`,
    // no-referrer 会让浏览器对表单 POST 发送 `Origin: null`，/consent 的 Origin 校验无法通过；same-origin 跨源仍不带 referrer。
    'referrer-policy': 'same-origin',
  })
}

async function consent(request: Request, env: Env, deps: Deps): Promise<Response> {
  const origin = request.headers.get('origin')
  if (origin !== env.PUBLIC_ORIGIN) return failure(403, '来源校验失败。')
  const form = await request.formData()
  const consentId = String(form.get('consent_id') ?? '')
  const cookie = cookieValue(request)
  const pending = consentId
    ? await consumePending<ConsentPayload>(env.DB, consentId, 'consent', deps.now())
    : null
  if (
    !pending ||
    !cookie ||
    !constantTimeEqual(pending.cookie_hash, await sha256Hex(cookie)) ||
    !constantTimeEqual(String(form.get('csrf') ?? ''), pending.payload.csrf)
  ) {
    return failure(400, '授权确认无效或已过期，请回到 ChatGPT 重新连接。')
  }
  const clearCookie = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`
  const { oauthReq, scopes } = pending.payload
  if (form.get('decision') !== 'approve') {
    const denied = errorRedirect(env, oauthReq, 'access_denied', 'The user denied the request')
    denied.headers.set('set-cookie', clearCookie)
    return denied
  }
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: env.OWNER_ID,
    scope: scopes,
    metadata: { method: 'access_oidc', consented_at: deps.now() },
    props: { owner_id: env.OWNER_ID },
  })
  logEvent({ event: 'auth', status: 'granted', count: scopes.length })
  return new Response(null, {
    status: 302,
    headers: { location: redirectTo, 'set-cookie': clearCookie, ...SECURITY_HEADERS },
  })
}
