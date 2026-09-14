import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorker, providerOptions } from '../src/index'
import { b64url, encoder, randomToken } from '../src/util'
import { ORIGIN } from './helpers'

// 合成 OIDC 身份提供方：本地生成 RS256 密钥，不访问任何真实 Access/IdP。
const IDP = 'https://idp.synthetic.test'
const CLIENT_SECRET = 'synthetic-access-client-secret' // SYNTHETIC-SECRET
const authEnv = {
  ...env,
  ACCESS_OIDC_ISSUER: IDP,
  ACCESS_OIDC_AUTHORIZATION_ENDPOINT: `${IDP}/authorize`,
  ACCESS_OIDC_TOKEN_ENDPOINT: `${IDP}/token`,
  ACCESS_OIDC_JWKS_URL: `${IDP}/jwks`,
  ACCESS_CLIENT_ID: 'access-client',
  ACCESS_CLIENT_SECRET: CLIENT_SECRET,
  OWNER_OIDC_SUB: 'owner-subject',
} as Env

const pair = (await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair
const otherPair = (await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair
const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)

async function signJwt(
  claims: Record<string, unknown>,
  key = pair.privateKey,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' },
) {
  const h = b64url(encoder.encode(JSON.stringify(header)))
  const p = b64url(encoder.encode(JSON.stringify(claims)))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(`${h}.${p}`))
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`
}

type ClaimsMutator = (claims: Record<string, unknown>) => Record<string, unknown>
const issued = new Map<string, { nonce: string; challenge: string }>()
let mutateClaims: ClaimsMutator = (c) => c
let signingKey = pair.privateKey
let idTokenHeader: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }
const upstreamSecrets: string[] = []

const idpFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.href === `${IDP}/jwks`) return Response.json({ keys: [{ ...publicJwk, kid: 'k1' }] })
  if (url.href === `${IDP}/token`) {
    const form = new URLSearchParams(String(init?.body ?? ''))
    const code = issued.get(form.get('code') ?? '')
    const verifier = form.get('code_verifier') ?? ''
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))))
    if (!code || form.get('client_secret') !== CLIENT_SECRET || challenge !== code.challenge) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    const now = Math.floor(Date.now() / 1000)
    const idToken = await signJwt(
      mutateClaims({
        iss: IDP,
        sub: 'owner-subject',
        aud: 'access-client',
        exp: now + 300,
        iat: now,
        nonce: code.nonce,
      }),
      signingKey,
      idTokenHeader,
    )
    upstreamSecrets.push(idToken)
    return Response.json({ id_token: idToken, access_token: 'upstream-access-token-synthetic' })
  }
  throw new Error(`unexpected fetch ${url.origin}`)
}) as typeof fetch

const worker = createWorker({ fetch: idpFetch, sleep: async () => {}, now: Date.now })

async function call(request: Request, e: Env = authEnv): Promise<Response> {
  const ctx = createExecutionContext()
  const response = await worker.fetch(request, e, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

async function newClient(redirect = 'https://client.test/callback') {
  const noop = { fetch: async () => new Response(null) }
  const helpers = getOAuthApi(providerOptions(authEnv, { apiHandler: noop, defaultHandler: noop }), authEnv)
  const client = await helpers.createClient({
    clientName: '<b>测试客户端</b>',
    redirectUris: [redirect],
    tokenEndpointAuthMethod: 'none',
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
  })
  return { client, helpers }
}

async function startAuthorize(ip: string, overrides: Record<string, string | null> = {}) {
  const { client, helpers } = await newClient()
  const verifier = randomToken()
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))))
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: 'https://client.test/callback',
    response_type: 'code',
    scope: 'body:read workout:read',
    state: 'client-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/mcp`,
  })
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) params.delete(k)
    else params.set(k, v)
  }
  const response = await call(
    new Request(`${ORIGIN}/authorize?${params}`, { headers: { 'cf-connecting-ip': ip } }),
  )
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
  return { response, cookie, client, helpers, verifier }
}

/** 模拟浏览器在 IdP 登录成功后被重定向回 /callback。 */
async function loginAtIdp(location: string) {
  const url = new URL(location)
  const code = randomToken()
  issued.set(code, {
    nonce: url.searchParams.get('nonce') ?? '',
    challenge: url.searchParams.get('code_challenge') ?? '',
  })
  return `${ORIGIN}/callback?code=${code}&state=${url.searchParams.get('state')}`
}

const consentFields = (html: string) => ({
  consent_id: /name="consent_id" value="([^"]+)"/.exec(html)?.[1] ?? '',
  csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '',
})

const postConsent = (
  ip: string,
  cookie: string,
  fields: Record<string, string>,
  origin: string | null = ORIGIN,
) =>
  call(
    new Request(`${ORIGIN}/consent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
        'cf-connecting-ip': ip,
        ...(origin ? { origin } : {}),
      },
      body: new URLSearchParams(fields),
    }),
  )

async function fullFlow(ip: string) {
  const start = await startAuthorize(ip)
  const callbackUrl = await loginAtIdp(start.response.headers.get('location') ?? '')
  const consentPage = await call(
    new Request(callbackUrl, { headers: { cookie: start.cookie, 'cf-connecting-ip': ip } }),
  )
  const html = await consentPage.text()
  return { start, callbackUrl, consentPage, html, fields: consentFields(html) }
}

const ip = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`

afterEach(() => {
  mutateClaims = (c) => c
  signingKey = pair.privateKey
  idTokenHeader = { alg: 'RS256', kid: 'k1' }
  vi.restoreAllMocks()
})

describe('Access OIDC 本人授权 + consent（合成 IdP）', () => {
  it('完整流程：PKCE、state/nonce、cookie 绑定、consent、iss 回传，签发的 token 可用且权限按 scope', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)))
    const address = ip()
    const flow = await fullFlow(address)
    const idpRedirect = new URL(flow.start.response.headers.get('location') ?? '')
    expect(idpRedirect.origin + idpRedirect.pathname).toBe(`${IDP}/authorize`)
    expect(idpRedirect.searchParams.get('code_challenge_method')).toBe('S256')
    expect(idpRedirect.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`)
    expect(flow.start.response.headers.get('set-cookie')).toMatch(
      /^__Host-kt_auth=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax/,
    )

    expect(flow.consentPage.status).toBe(200)
    expect(flow.html).toContain('&lt;b&gt;测试客户端&lt;/b&gt;')
    expect(flow.html).toContain('读取训练记录与趋势')
    expect(flow.consentPage.headers.get('content-security-policy')).toContain(
      "form-action 'self' https://client.test",
    )
    expect(flow.consentPage.headers.get('x-frame-options')).toBe('DENY')

    const approved = await postConsent(address, flow.start.cookie, { ...flow.fields, decision: 'approve' })
    expect(approved.status).toBe(302)
    const redirect = new URL(approved.headers.get('location') ?? '')
    expect(redirect.origin).toBe('https://client.test')
    expect(redirect.searchParams.get('state')).toBe('client-state')
    expect(redirect.searchParams.get('iss')).toBe(ORIGIN)
    const code = redirect.searchParams.get('code') ?? ''

    const tokenRes = await call(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: flow.start.client.clientId,
          redirect_uri: 'https://client.test/callback',
          code,
          code_verifier: flow.start.verifier,
          resource: `${ORIGIN}/mcp`,
        }),
      }),
    )
    expect(tokenRes.status).toBe(200)
    const token = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string }
    expect(token.scope.split(' ').sort()).toEqual(['body:read', 'workout:read'])

    const mcp = (accessToken: string, body: unknown) =>
      call(
        new Request(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(body),
        }),
      )
    const list = await mcp(token.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(list.status).toBe(200)
    const write = await (
      await mcp(token.access_token, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_write_receipt', arguments: { idempotency_key: 'k'.repeat(20) } },
      })
    ).json<{ result: { structuredContent: { status: string } } }>()
    expect(write.result.structuredContent.status).toBe('empty')

    // 刷新时降权到 body:read 后训练读取被拒（以 token 自身 scope 为准）。
    const narrowRes = await call(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: flow.start.client.clientId,
          refresh_token: token.refresh_token,
          scope: 'body:read',
          resource: `${ORIGIN}/mcp`,
        }),
      }),
    )
    expect(narrowRes.status).toBe(200)
    const narrow = (await narrowRes.json()) as { access_token: string }
    const denied = await (
      await mcp(narrow.access_token, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_write_receipt', arguments: { idempotency_key: 'k'.repeat(20) } },
      })
    ).json<{ result: { structuredContent: { error: { code: string } } } }>()
    expect(denied.result.structuredContent.error.code).toBe('INSUFFICIENT_SCOPE')

    // 授权码重放被拒，且 Provider 撤销该 grant：已签发的 token 随之失效。
    const replay = await call(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: flow.start.client.clientId,
          redirect_uri: 'https://client.test/callback',
          code,
          code_verifier: flow.start.verifier,
        }),
      }),
    )
    expect(replay.status).toBe(400)
    expect((await mcp(narrow.access_token, { jsonrpc: '2.0', id: 4, method: 'tools/list' })).status).toBe(401)

    // 主动撤销：另一次授权签发的 token 在 revokeGrant 后同样 401。
    const secondAddress = ip()
    const second = await fullFlow(secondAddress)
    const secondApproved = await postConsent(secondAddress, second.start.cookie, {
      ...second.fields,
      decision: 'approve',
    })
    const secondCode = new URL(secondApproved.headers.get('location') ?? '').searchParams.get('code') ?? ''
    const secondToken = (await (
      await call(
        new Request(`${ORIGIN}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: second.start.client.clientId,
            redirect_uri: 'https://client.test/callback',
            code: secondCode,
            code_verifier: second.start.verifier,
            resource: `${ORIGIN}/mcp`,
          }),
        }),
      )
    ).json()) as { access_token: string }
    expect(
      (await mcp(secondToken.access_token, { jsonrpc: '2.0', id: 5, method: 'tools/list' })).status,
    ).toBe(200)
    const grants = await second.start.helpers.listUserGrants(env.OWNER_ID)
    for (const grant of grants.items) await second.start.helpers.revokeGrant(grant.id, env.OWNER_ID)
    expect(
      (await mcp(secondToken.access_token, { jsonrpc: '2.0', id: 6, method: 'tools/list' })).status,
    ).toBe(401)

    const joined = logs.join('\n')
    for (const secret of [
      ...upstreamSecrets,
      'upstream-access-token-synthetic',
      code,
      token.access_token,
      flow.start.cookie,
    ]) {
      expect(joined).not.toContain(secret)
    }
  })

  it('非本人身份 403；nonce/aud/iss/过期/签名/算法错误 400；均不进入 consent', async () => {
    const cases: [string, () => void, number][] = [
      ['wrong sub', () => (mutateClaims = (c) => ({ ...c, sub: 'someone-else' })), 403],
      ['wrong nonce', () => (mutateClaims = (c) => ({ ...c, nonce: 'forged' })), 400],
      ['wrong aud', () => (mutateClaims = (c) => ({ ...c, aud: 'other-client' })), 400],
      ['wrong iss', () => (mutateClaims = (c) => ({ ...c, iss: 'https://evil.test' })), 400],
      ['expired', () => (mutateClaims = (c) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 })), 400],
      ['bad signature', () => (signingKey = otherPair.privateKey), 400],
      ['alg none', () => (idTokenHeader = { alg: 'none', kid: 'k1' }), 400],
    ]
    for (const [name, arrange, status] of cases) {
      arrange()
      const address = ip()
      const start = await startAuthorize(address)
      const callbackUrl = await loginAtIdp(start.response.headers.get('location') ?? '')
      const res = await call(
        new Request(callbackUrl, { headers: { cookie: start.cookie, 'cf-connecting-ip': address } }),
      )
      expect(res.status, name).toBe(status)
      expect(await res.text(), name).not.toContain('consent_id')
      mutateClaims = (c) => c
      signingKey = pair.privateKey
      idTokenHeader = { alg: 'RS256', kid: 'k1' }
    }
  })

  it('state 一次性、cookie 绑定浏览器；consent 校验 Origin/CSRF 且一次性；拒绝时回传 access_denied', async () => {
    const address = ip()
    const flow = await fullFlow(address)
    const again = await call(
      new Request(flow.callbackUrl, { headers: { cookie: flow.start.cookie, 'cf-connecting-ip': address } }),
    )
    expect(again.status).toBe(400)

    const other = await startAuthorize(address)
    const otherCallback = await loginAtIdp(other.response.headers.get('location') ?? '')
    expect(
      (await call(new Request(otherCallback, { headers: { 'cf-connecting-ip': address } }))).status,
    ).toBe(400)

    expect(
      (
        await postConsent(
          address,
          flow.start.cookie,
          { ...flow.fields, decision: 'approve' },
          'https://evil.test',
        )
      ).status,
    ).toBe(403)
    expect(
      (await postConsent(address, flow.start.cookie, { ...flow.fields, decision: 'approve' }, null)).status,
    ).toBe(403)
    // 伪造 CSRF 会消费掉该 consent，之后即使带正确 CSRF 也不能再用。
    expect(
      (await postConsent(address, flow.start.cookie, { ...flow.fields, csrf: 'forged', decision: 'approve' }))
        .status,
    ).toBe(400)
    expect(
      (await postConsent(address, flow.start.cookie, { ...flow.fields, decision: 'approve' })).status,
    ).toBe(400)

    const deny = await fullFlow(address)
    const denied = await postConsent(address, deny.start.cookie, { ...deny.fields, decision: 'deny' })
    expect(denied.status).toBe(302)
    const location = new URL(denied.headers.get('location') ?? '')
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('state')).toBe('client-state')
    expect(location.searchParams.get('iss')).toBe(ORIGIN)
    expect(location.searchParams.get('code')).toBeNull()
  })

  it('authorize 校验 PKCE、回调地址、resource、scope；未配置 IdP 时 503；按 IP 限流', async () => {
    const noPkce = await startAuthorize(ip(), { code_challenge: null, code_challenge_method: null })
    expect(noPkce.cookie).toBe('')
    expect(noPkce.response.headers.get('location') ?? '').not.toContain(IDP)
    const plain = await startAuthorize(ip(), { code_challenge_method: 'plain' })
    expect(plain.response.headers.get('location') ?? '').not.toContain(IDP)
    const badRedirect = await startAuthorize(ip(), { redirect_uri: 'https://evil.test/cb' })
    expect(badRedirect.response.status).toBe(400)
    expect(badRedirect.response.headers.get('location')).toBeNull()
    const badResource = await startAuthorize(ip(), { resource: 'https://other.test/mcp' })
    expect(badResource.response.headers.get('location') ?? '').not.toContain(IDP)
    const badScope = await startAuthorize(ip(), { scope: 'body:read workout:delete' })
    expect(new URL(badScope.response.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_scope',
    )

    // Provider 只对公开客户端强制 PKCE；OAuth 2.1 要求所有客户端都用 S256，由授权页自行拒绝。
    const noop = { fetch: async () => new Response(null) }
    const helpers = getOAuthApi(providerOptions(authEnv, { apiHandler: noop, defaultHandler: noop }), authEnv)
    const confidential = await helpers.createClient({
      clientName: 'confidential',
      redirectUris: ['https://client.test/callback'],
      tokenEndpointAuthMethod: 'client_secret_basic',
      grantTypes: ['authorization_code'],
      responseTypes: ['code'],
    })
    const noPkceConfidential = await call(
      new Request(
        `${ORIGIN}/authorize?${new URLSearchParams({
          client_id: confidential.clientId,
          redirect_uri: 'https://client.test/callback',
          response_type: 'code',
          scope: 'body:read',
          state: 's',
        })}`,
        { headers: { 'cf-connecting-ip': ip() } },
      ),
    )
    expect(noPkceConfidential.status).toBe(302)
    expect(new URL(noPkceConfidential.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_request',
    )
    expect(noPkceConfidential.headers.get('set-cookie')).toBeNull()

    const unconfigured = await call(new Request(`${ORIGIN}/authorize?client_id=x`), env)
    expect(unconfigured.status).toBe(503)

    const address = ip()
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (
          await call(
            new Request(`${ORIGIN}/authorize?client_id=x`, { headers: { 'cf-connecting-ip': address } }),
          )
        ).status,
      )
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true)
    expect(statuses[10]).toBe(429)
  })
})
