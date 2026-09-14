import { describe, expect, it } from 'vitest'
import { createWorker } from '../src/index'
import { callTool, dispatch, issueToken, ORIGIN, rpc, testDeps } from './helpers'

describe('MCP HTTP 边界', () => {
  const worker = createWorker(testDeps())

  it('匿名 /mcp 返回 401 与 resource_metadata challenge，不是 HTML', async () => {
    const res = await dispatch(worker, new Request(`${ORIGIN}/mcp`, { method: 'POST', body: '{}' }))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    )
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html')
  })

  it('无效 token 返回 401', async () => {
    const res = await rpc(worker, 'owner:grant:not-a-real-token', 'tools/list')
    expect(res.status).toBe(401)
  })

  it('发现文档：S256、四个 scope、资源精确为 /mcp', async () => {
    const as = await (
      await dispatch(worker, new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))
    ).json<Record<string, string[]>>()
    expect(as.code_challenge_methods_supported).toEqual(['S256'])
    expect(as.scopes_supported).toEqual(['body:read', 'body:sync', 'workout:read', 'workout:write'])
    const pr = await (
      await dispatch(worker, new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`))
    ).json<Record<string, unknown>>()
    expect(pr.resource).toBe(`${ORIGIN}/mcp`)
    expect(pr.scopes_supported).toEqual(['body:read', 'workout:read'])
  })

  it('scope 不足：工具结果 isError + mcp/www_authenticate，且不执行处理函数', async () => {
    const { access_token } = await issueToken(worker, ['body:read'])
    const result = await callTool(worker, access_token, 'record_workout_event', {})
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(result.structuredContent.persistence).toBe('not_committed')
    expect(result.content[0].text).toContain('本次未持久化')
    const header = result._meta['mcp/www_authenticate'][0] as string
    expect(header).toContain('error="insufficient_scope"')
    expect(header).toContain('error_description="Required scope is missing"')
    expect(header).toContain('workout:write')
    expect(header).toContain('body:read')
  })

  it('GET 405、外部 Origin 403、超过 64 KiB 的请求 413', async () => {
    const { access_token } = await issueToken(worker, ['body:read'])
    const auth = { authorization: `Bearer ${access_token}` }
    expect((await dispatch(worker, new Request(`${ORIGIN}/mcp`, { headers: auth }))).status).toBe(405)
    expect(
      (await rpc(worker, access_token, 'tools/list', {}, { origin: 'https://evil.example' })).status,
    ).toBe(403)
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { pad: 'x'.repeat(70_000) },
    })
    const res = await dispatch(
      worker,
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: big,
      }),
    )
    expect(res.status).toBe(413)
  })

  it('healthz 只返回存活状态', async () => {
    const res = await dispatch(worker, new Request(`${ORIGIN}/healthz`))
    expect(await res.json()).toEqual({ status: 'alive' })
  })
})
