// 生产 bundle 互通检查：wrangler 构建的 dist + Miniflare(workerd) + 真实 MCP Inspector CLI（官方 SDK 客户端）。
// 仅本地合成数据。合成 token 由测试 harness 通过 Provider helper 签发，只在回环代理内存中注入，不写入参数或文件。
// 运行：在 research/spike 下 `npx --yes --package=node@22.23.2 node production-inspector-check.mjs`
import assert from 'node:assert/strict'
import { execFile, execSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const ROOT = new URL('../../', import.meta.url)
const LOCAL = new URL('./.local/', import.meta.url)
await mkdir(new URL('./prod/', LOCAL), { recursive: true })
execSync(`npx wrangler deploy --dry-run --outdir "${new URL('./prod/', LOCAL).pathname.replace(/^\/([A-Za-z]:)/, '$1')}"`, {
  cwd: ROOT,
  stdio: 'ignore',
  shell: true,
})

await writeFile(
  new URL('./harness.mjs', LOCAL),
  `import prod from './prod/index.js'
import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
const noop = { fetch: async () => new Response(null) }
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname !== '/__synthetic_mint') return prod.fetch(request, env, ctx)
    if (env.SYNTHETIC_ONLY !== 'true' || url.hostname !== 'localhost') return new Response(null, { status: 403 })
    const helpers = getOAuthApi({ apiRoute: '/mcp', apiHandler: noop, defaultHandler: noop, authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token', allowPlainPKCE: false,
      resourceMetadata: { resource: env.PUBLIC_ORIGIN + '/mcp', authorization_servers: [env.PUBLIC_ORIGIN] } }, env)
    const client = await helpers.createClient({ clientName: 'inspector-check', redirectUris: ['https://localhost/cb'],
      tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code'], responseTypes: ['code'] })
    const verifier = b64(crypto.getRandomValues(new Uint8Array(32)))
    const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    const scope = url.searchParams.get('scope')
    const params = new URLSearchParams({ client_id: client.clientId, redirect_uri: 'https://localhost/cb', response_type: 'code',
      scope, state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: env.PUBLIC_ORIGIN + '/mcp' })
    const authReq = await helpers.parseAuthRequest(new Request(env.PUBLIC_ORIGIN + '/authorize?' + params))
    const { redirectTo } = await helpers.completeAuthorization({ request: authReq, userId: env.OWNER_ID, scope: scope.split(' '),
      metadata: { synthetic: true }, props: { owner_id: env.OWNER_ID } })
    const code = new URL(redirectTo).searchParams.get('code')
    return prod.fetch(new Request(env.PUBLIC_ORIGIN + '/oauth/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.clientId, redirect_uri: 'https://localhost/cb',
        code, code_verifier: verifier, resource: env.PUBLIC_ORIGIN + '/mcp' }) }), env, ctx)
  },
}
`,
)
await build({
  entryPoints: [new URL('./harness.mjs', LOCAL).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  outfile: new URL('./harness-bundle.mjs', LOCAL).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'],
  external: ['cloudflare:workers', 'node:*'],
})

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: new URL('./harness-bundle.mjs', LOCAL).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    compatibilityDate: '2026-09-14',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    kvNamespaces: ['OAUTH_KV'],
    d1Databases: ['DB'],
    bindings: {
      SYNTHETIC_ONLY: 'true',
      PUBLIC_ORIGIN: 'https://localhost',
      OWNER_ID: 'owner',
      FITDAYS_HISTORY_START: '2026-06-01T00:00:00+08:00',
      CURSOR_SIGNING_KEY: randomBytes(32).toString('hex'),
      ACCESS_OIDC_ISSUER: '',
      ACCESS_OIDC_AUTHORIZATION_ENDPOINT: '',
      ACCESS_OIDC_TOKEN_ENDPOINT: '',
      ACCESS_OIDC_JWKS_URL: '',
      ACCESS_CLIENT_ID: '',
      OWNER_OIDC_SUB: '',
    },
  }),
)
const report = { synthetic_only: true, bundle: 'wrangler deploy --dry-run output' }
try {
  const db = await mf.getD1Database('DB')
  const sql = (await readFile(new URL('./migrations/0001_init.sql', ROOT), 'utf8'))
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
  const statements = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)
  await db.batch(statements.map((s) => db.prepare(s)))

  const call = (path, init) => mf.dispatchFetch(`https://localhost${path}`, init)
  const unauth = await call('/mcp', { method: 'POST', body: '{}' })
  assert.equal(unauth.status, 401)
  report.anonymous_mcp_401 = true
  const mint = async (scope) => (await (await call(`/__synthetic_mint?scope=${encodeURIComponent(scope)}`)).json()).access_token

  async function withProxy(token, fn) {
    const proxy = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const upstream = await call('/mcp', {
        method: req.method,
        headers: { ...req.headers, authorization: `Bearer ${token}` },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      })
      const headers = Object.fromEntries(upstream.headers)
      delete headers['content-length']
      delete headers['content-encoding']
      res.writeHead(upstream.status, headers)
      res.end(Buffer.from(await upstream.arrayBuffer()))
    })
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    try {
      return await fn(`http://127.0.0.1:${proxy.address().port}/mcp`)
    } finally {
      await new Promise((resolve) => proxy.close(resolve))
    }
  }
  const cli = 'node_modules/@modelcontextprotocol/inspector/clients/cli/build/index.js'
  const inspector = async (url, args) => {
    let stdout
    try {
      ;({ stdout } = await promisify(execFile)(
        process.execPath,
        [cli, url, '--transport', 'http', '--format', 'json', '--stored-auth-only', ...args],
        { timeout: 30000 },
      ))
    } catch (error) {
      // Inspector 对 isError:true 的工具结果以退出码 5 结束，但仍输出完整结果。
      if (error.code !== 5) throw error
      stdout = error.stdout
    }
    const parsed = JSON.parse(stdout)
    return parsed.result ?? parsed
  }

  const reader = await mint('body:read workout:read')
  const writer = await mint('body:read workout:read workout:write')
  await withProxy(reader, async (url) => {
    const listed = await inspector(url, ['--method', 'tools/list'])
    assert.equal(listed.tools.length, 19)
    report.inspector_tools_list = listed.tools.length
    const status = await inspector(url, ['--method', 'tools/call', '--tool-name', 'get_sync_status'])
    assert.equal(status.structuredContent.status, 'ok')
    const denied = await inspector(url, [
      '--method', 'tools/call', '--tool-name', 'start_workout_session',
      '--tool-arg', `idempotency_key=${createHash('sha256').update('denied').digest('hex').slice(0, 32)}`,
      '--tool-arg', 'expected_revision=0', '--tool-arg', 'started_at=2026-09-14T18:00:00+08:00',
      '--tool-arg', 'timezone=Asia/Shanghai', '--tool-arg', 'raw_text=我到健身房了',
    ])
    assert.equal(denied.isError, true)
    assert.equal(denied.structuredContent.error.code, 'INSUFFICIENT_SCOPE')
    report.inspector_scope_denied = true
  })
  await withProxy(writer, async (url) => {
    const started = await inspector(url, [
      '--method', 'tools/call', '--tool-name', 'start_workout_session',
      '--tool-arg', `idempotency_key=${randomBytes(16).toString('hex')}`,
      '--tool-arg', 'expected_revision=0', '--tool-arg', 'started_at=2026-09-14T18:00:00+08:00',
      '--tool-arg', 'timezone=Asia/Shanghai', '--tool-arg', 'raw_text=我到健身房了',
    ])
    assert.equal(started.structuredContent.persistence, 'committed')
    const open = await inspector(url, ['--method', 'tools/call', '--tool-name', 'get_open_workout_sessions'])
    assert.equal(open.structuredContent.data.length, 1)
    report.inspector_write_then_read = true
  })
} finally {
  await mf.dispose()
}
report.runtime = process.version
await writeFile(new URL('../production-inspector-results.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
