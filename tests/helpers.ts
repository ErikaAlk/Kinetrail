import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import { type createWorker, providerOptions } from '../src/index'
import type { Deps } from '../src/mcp'
import { b64url, encoder, randomToken } from '../src/util'

export const ORIGIN = env.PUBLIC_ORIGIN

// biome-ignore lint/suspicious/noExplicitAny: 测试中读取任意结构化结果
export type Loose = any

export function testDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    fetch: async () => {
      throw new Error('network disabled in tests')
    },
    sleep: async () => {},
    now: () => Date.now(),
    ...overrides,
  }
}

export async function dispatch(worker: ReturnType<typeof createWorker>, request: Request): Promise<Response> {
  const ctx = createExecutionContext()
  const response = await worker.fetch(request, env, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

/** 走真实 Provider 的授权码 + PKCE + token 交换，签发给本人（OWNER_ID）的 access token。 */
export async function issueToken(
  worker: ReturnType<typeof createWorker>,
  scopes: string[],
  userId = env.OWNER_ID,
): Promise<{ access_token: string; refresh_token: string; client_id: string }> {
  const noop = { fetch: async () => new Response(null) }
  const helpers = getOAuthApi(providerOptions(env, { apiHandler: noop, defaultHandler: noop }), env)
  const client = await helpers.createClient({
    clientName: 'test-client',
    redirectUris: ['https://client.test/callback'],
    tokenEndpointAuthMethod: 'none',
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
  })
  const verifier = randomToken()
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))))
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: 'https://client.test/callback',
    response_type: 'code',
    scope: scopes.join(' '),
    state: 'test-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/mcp`,
  })
  const authRequest = await helpers.parseAuthRequest(new Request(`${ORIGIN}/authorize?${params}`))
  const { redirectTo } = await helpers.completeAuthorization({
    request: authRequest,
    userId,
    scope: scopes,
    metadata: {},
    props: { owner_id: userId },
  })
  const code = new URL(redirectTo).searchParams.get('code') ?? ''
  const response = await dispatch(
    worker,
    new Request(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        redirect_uri: 'https://client.test/callback',
        code,
        code_verifier: verifier,
        resource: `${ORIGIN}/mcp`,
      }),
    }),
  )
  if (response.status !== 200) throw new Error(`token exchange failed: ${response.status}`)
  const token = (await response.json()) as { access_token: string; refresh_token: string }
  return { ...token, client_id: client.clientId }
}

export async function rpc(
  worker: ReturnType<typeof createWorker>,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const response = await dispatch(
    worker,
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null }
}

export async function callTool(
  worker: ReturnType<typeof createWorker>,
  token: string,
  name: string,
  args: unknown,
): Promise<Loose> {
  const res = await rpc(worker, token, 'tools/call', { name, arguments: args })
  if (res.status !== 200) throw new Error(`tools/call HTTP ${res.status}`)
  return res.body.result
}
