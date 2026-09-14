import { env } from 'cloudflare:workers'
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
    // 参数完全合法：只有 scope 检查能挡住它，才能证明处理函数没有执行。
    const result = await callTool(worker, access_token, 'record_workout_event', {
      idempotency_key: crypto.randomUUID(),
      expected_revision: 0,
      occurred_at: new Date(Date.now() - 60_000).toISOString(),
      timezone: 'Asia/Shanghai',
      raw_text: '我已完成高位下拉45kg，12次',
      completion: 'completed',
      entries: [
        {
          exercise_name_raw: '高位下拉',
          category: 'strength',
          sets: [{ load_value: 45, load_unit: 'kg', reps: 12 }],
        },
      ],
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(result.structuredContent.persistence).toBe('not_committed')
    expect(result.content[0].text).toContain('本次未持久化')
    const header = result._meta['mcp/www_authenticate'][0] as string
    expect(header).toContain('error="insufficient_scope"')
    expect(header).toContain('error_description="Required scope is missing"')
    expect(header).toContain('workout:write')
    expect(header).toContain('body:read')
    // 处理函数未执行：库里没有任何训练事件或会话
    const rows = await env.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM workout_events) + (SELECT COUNT(*) FROM workout_sessions) AS n',
    ).first<{ n: number }>()
    expect(rows?.n).toBe(0)
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

  it('协议面：initialize 版本协商、通知 202、ping、未知方法、解析错误、Accept/Content-Type/版本头校验、批量', async () => {
    const { access_token } = await issueToken(worker, ['body:read'])
    const init = await rpc(worker, access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    })
    expect(init.body.result.protocolVersion).toBe('2025-06-18')
    expect(init.body.result.capabilities.tools).toBeDefined()
    const future = await rpc(worker, access_token, 'initialize', { protocolVersion: '2099-01-01' })
    expect(future.body.result.protocolVersion).toBe('2025-11-25')
    expect((await rpc(worker, access_token, 'ping')).body.result).toEqual({})
    expect((await rpc(worker, access_token, 'resources/list')).body.error.code).toBe(-32601)
    expect((await rpc(worker, access_token, 'tools/call', { name: 'no_such_tool' })).body.error.code).toBe(
      -32602,
    )

    const post = (body: string, headers: Record<string, string> = {}) =>
      dispatch(
        worker,
        new Request(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
          body,
        }),
      )
    expect((await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status).toBe(
      202,
    )
    const parse = await post('{not json')
    expect(parse.status).toBe(400)
    expect(((await parse.json()) as { error: { code: number } }).error.code).toBe(-32700)
    expect((await post('{}', { accept: 'application/json' })).status).toBe(406)
    expect((await post('{}', { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post('{}', { 'mcp-protocol-version': '1999-01-01' })).status).toBe(400)
    const batch = await post(
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]),
    )
    const replies = (await batch.json()) as { id: number }[]
    expect(replies.map((r) => r.id)).toEqual([1, 2])
  })

  it('第二轮回归：批量条数上限、HTTP 层总限流（含 tools/list）', async () => {
    // 固定时钟，避免 121 次请求恰好跨过分钟窗口导致偶发失败。
    const limited = createWorker(testDeps({ now: () => 1_789_400_000_000 }))
    const { access_token } = await issueToken(limited, ['body:read'])
    const post = (body: unknown) =>
      dispatch(
        limited,
        new Request(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(body),
        }),
      )
    const flood = Array.from({ length: 50 }, () => ({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    expect((await post(flood)).status).toBe(400)
    // 合计响应超限时逐项替换为错误，不整体丢弃；写工具不允许进批量，且不会执行。
    const lists = await post(
      Array.from({ length: 4 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/list' })),
    )
    expect(lists.status).toBe(200)
    const listText = await lists.text()
    expect(new TextEncoder().encode(listText).byteLength).toBeLessThanOrEqual(256 * 1024)
    expect((JSON.parse(listText) as { id: number }[]).map((r) => r.id)).toEqual([0, 1, 2, 3])
    const writer = await issueToken(limited, ['workout:read', 'workout:write'])
    const writeBatch = await dispatch(
      limited,
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${writer.access_token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify([
          {
            jsonrpc: '2.0',
            id: 'w',
            method: 'tools/call',
            params: {
              name: 'start_workout_session',
              arguments: {
                idempotency_key: crypto.randomUUID(),
                expected_revision: 0,
                started_at: new Date(Date.now() - 60_000).toISOString(),
                timezone: 'Asia/Shanghai',
                raw_text: '到健身房了',
              },
            },
          },
          { jsonrpc: '2.0', id: 'p', method: 'ping' },
        ]),
      }),
    )
    const writeReplies = (await writeBatch.json()) as {
      id: string
      error?: { code: number }
      result?: unknown
    }[]
    expect(writeReplies.find((r) => r.id === 'w')?.error?.code).toBe(-32600)
    expect(writeReplies.find((r) => r.id === 'p')?.result).toEqual({})
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM workout_sessions').first<{ n: number }>())?.n,
    ).toBe(0)
    const statuses: number[] = []
    for (let i = 0; i < 121; i++)
      statuses.push((await post({ jsonrpc: '2.0', id: i, method: 'ping' })).status)
    // 同文件其他用例共用同一 owner 的分钟窗口，所以只断言：达到 120 次后开始限流，且之后一直限流。
    const firstLimited = statuses.indexOf(429)
    expect(firstLimited).toBeGreaterThan(90)
    expect(statuses.slice(firstLimited).every((s) => s === 429)).toBe(true)
  })

  it('healthz 只返回存活状态', async () => {
    const res = await dispatch(worker, new Request(`${ORIGIN}/healthz`))
    expect(await res.json()).toEqual({ status: 'alive' })
  })
})
