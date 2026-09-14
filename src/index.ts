// Worker 入口：OAuth Provider 包住 /mcp；其余路由为授权页、健康检查；cron 负责同步队列与定期刷新。

import { OAuthProvider, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider'
import { handleAuthRoutes, purgeAuthPending } from './auth'
import { buildRegistry, type Deps, handleMcpRequest, resourceMetadataUrl, resourceUrl } from './mcp'
import { consumeRateLimit, purgeRateLimits } from './ratelimit'
import { scheduledSync } from './sync'
import { TOOLS } from './tools'
import { KtError } from './util'

export function providerOptions(
  env: Env,
  handlers: Pick<OAuthProviderOptions<Env>, 'apiHandler' | 'defaultHandler'>,
) {
  return {
    ...handlers,
    apiRoute: '/mcp',
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    allowPlainPKCE: false,
    allowImplicitFlow: false,
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ['body:read', 'body:sync', 'workout:read', 'workout:write'],
    resourceMetadata: {
      resource: resourceUrl(env),
      authorization_servers: [env.PUBLIC_ORIGIN],
      scopes_supported: ['body:read', 'workout:read'],
      resource_name: 'Kinetrail',
    },
  } satisfies OAuthProviderOptions<Env>
}

const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'unknown'

export function createWorker(deps: Deps) {
  const registry = buildRegistry(TOOLS)

  const apiHandler = {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const bearer = request.headers.get('authorization')?.slice('Bearer '.length) ?? ''
      // 以 token 自身的当前 scope 为准（支持刷新降权），不读 grant.props 里的旧 scopes。
      const token = await env.OAUTH_PROVIDER.unwrapToken(bearer)
      if (
        !token ||
        token.userId !== env.OWNER_ID ||
        (ctx.props as { owner_id?: string } | undefined)?.owner_id !== env.OWNER_ID
      ) {
        return new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(env)}", error="invalid_token"`,
          },
        })
      }
      return handleMcpRequest(request, registry, {
        env,
        ownerId: env.OWNER_ID,
        scopes: new Set(token.scope),
        deps,
        waitUntil: (p) => ctx.waitUntil(p),
      })
    },
  }

  const defaultHandler = {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === '/healthz') return Response.json({ status: 'alive' })
      const auth = await handleAuthRoutes(request, env, deps)
      return auth ?? new Response('Not found', { status: 404 })
    },
  }

  let cached: { origin: string; provider: OAuthProvider<Env> } | undefined
  const provider = (env: Env) => {
    if (cached?.origin !== env.PUBLIC_ORIGIN) {
      cached = {
        origin: env.PUBLIC_ORIGIN,
        provider: new OAuthProvider(providerOptions(env, { apiHandler, defaultHandler })),
      }
    }
    return cached.provider
  }

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url)
      try {
        if (url.pathname === '/oauth/token' && request.method === 'POST') {
          const form = await request.clone().formData()
          const client = String(form.get('client_id') ?? 'unknown').slice(0, 256)
          await consumeRateLimit(env.DB, `token:${client}:${clientIp(request)}`, 20, 60, deps.now())
        }
      } catch (error) {
        if (error instanceof KtError && error.code === 'RATE_LIMITED') {
          return Response.json(
            { error: 'temporarily_unavailable', error_description: 'rate limited' },
            { status: 429, headers: { 'Retry-After': String(error.options.retryAfterSeconds ?? 60) } },
          )
        }
        throw error
      }
      return provider(env).fetch(request, env, ctx)
    },

    async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
      ctx.waitUntil(
        (async () => {
          await purgeRateLimits(env.DB, deps.now())
          await purgeAuthPending(env.DB, deps.now())
          await scheduledSync(env, deps)
        })(),
      )
    },
  }
}

export default createWorker({
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
})
