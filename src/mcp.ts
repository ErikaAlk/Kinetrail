// Streamable HTTP（无状态、JSON 响应）+ 工具注册、scope、限流、输入/输出校验和统一信封。

import { Validator } from '@cfworker/json-schema'
import { consumeRateLimit } from './ratelimit'
import { findSecretPath } from './sanitize'
import { type ContractTool, contractTools, inlineRefs, type Scope } from './schemas'
import { byteLength, KtError, logEvent, readBodyLimited } from './util'

export interface CallToolResult {
  structuredContent: Record<string, unknown>
  content: { type: 'text'; text: string }[]
  isError?: boolean
  _meta?: Record<string, unknown>
}

export const MAX_REQUEST_BYTES = 64 * 1024
export const MAX_RESPONSE_BYTES = 256 * 1024
export const MAX_BATCH = 4
export const ALL_SCOPES: Scope[] = ['body:read', 'body:sync', 'workout:read', 'workout:write']

export interface Deps {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export interface ToolContext {
  env: Env
  ownerId: string
  scopes: ReadonlySet<string>
  requestId: string
  deps: Deps
  waitUntil: (promise: Promise<unknown>) => void
}

export interface ToolOutcome {
  data: unknown
  summary: string
  status?: 'ok' | 'empty'
  nextCursor?: string | null
  stale?: boolean
  syncedAt?: string | null
}

export interface ToolDefinition {
  name: string
  title: string
  description: string
  // biome-ignore lint/suspicious/noExplicitAny: 输入已由 JSON Schema 校验，处理函数自行收窄
  handler: (args: any, ctx: ToolContext) => Promise<ToolOutcome>
}

interface RegisteredTool extends ToolDefinition {
  contract: ContractTool
  descriptor: Record<string, unknown>
  input: Validator
  output: Validator
  write: boolean
}

export function buildRegistry(definitions: ToolDefinition[]): Map<string, RegisteredTool> {
  const registry = new Map<string, RegisteredTool>()
  for (const contract of contractTools) {
    const def = definitions.find((d) => d.name === contract.name)
    if (!def) throw new Error(`tool ${contract.name} has no implementation`)
    const inputSchema = inlineRefs(contract.inputSchema) as Record<string, unknown>
    const outputSchema = inlineRefs(contract.outputSchema) as Record<string, unknown>
    registry.set(contract.name, {
      ...def,
      contract,
      write: !contract.annotations.readOnlyHint,
      input: new Validator(inputSchema, '2020-12', false),
      output: new Validator(outputSchema, '2020-12', false),
      descriptor: {
        name: contract.name,
        title: def.title,
        description: def.description,
        inputSchema,
        outputSchema,
        annotations: { title: def.title, ...contract.annotations },
        securitySchemes: contract.securitySchemes,
        _meta: contract._meta,
      },
    })
  }
  if (definitions.length !== registry.size) throw new Error('tool definitions do not match the contract')
  return registry
}

export const resourceUrl = (env: Env) => `${env.PUBLIC_ORIGIN}/mcp`
export const resourceMetadataUrl = (env: Env) =>
  `${env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp`

function challenge(env: Env, scopes: string[]): string {
  return `Bearer resource_metadata="${resourceMetadataUrl(env)}", error="insufficient_scope", error_description="Required scope is missing", scope="${scopes.join(' ')}"`
}

export interface Envelope {
  schema_version: '1'
  request_id: string
  status: 'ok' | 'empty' | 'error'
  data: unknown
  error: null | {
    code: string
    message: string
    retryable: boolean
    persistence: 'not_applicable' | 'not_committed' | 'unknown'
    retry_after_seconds?: number
    current_revision?: number
  }
  stale: boolean
  synced_at: string | null
  next_cursor: string | null
  persistence: 'not_applicable' | 'committed' | 'not_committed' | 'unknown'
}

function errorEnvelope(requestId: string, write: boolean, error: KtError): Envelope {
  const persistence = error.options.persistence ?? (write ? 'not_committed' : 'not_applicable')
  return {
    schema_version: '1',
    request_id: requestId,
    status: 'error',
    data: null,
    error: {
      code: error.code,
      message: error.userMessage,
      retryable: error.options.retryable ?? false,
      persistence,
      ...(error.options.retryAfterSeconds !== undefined
        ? { retry_after_seconds: error.options.retryAfterSeconds }
        : {}),
      ...(error.options.currentRevision !== undefined
        ? { current_revision: error.options.currentRevision }
        : {}),
    },
    stale: false,
    synced_at: null,
    next_cursor: null,
    persistence: write
      ? persistence === 'not_applicable'
        ? 'not_committed'
        : persistence
      : 'not_applicable',
  }
}

function errorText(write: boolean, envelope: Envelope): string {
  const err = envelope.error
  if (!err) return ''
  if (!write) return `${err.code}：${err.message}`
  if (envelope.persistence === 'unknown') return `未能确认持久化（${err.code}）：${err.message}`
  return `本次未持久化（${err.code}）：${err.message}`
}

export async function callTool(
  registry: Map<string, RegisteredTool>,
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<CallToolResult> {
  const tool = registry.get(name)
  if (!tool) throw new Error('unknown tool')
  const started = Date.now()
  const required = tool.contract.securitySchemes[0]?.scopes ?? []
  let envelope: Envelope
  let meta: Record<string, unknown> | undefined

  try {
    const missing = required.filter((s) => !ctx.scopes.has(s))
    if (missing.length > 0) {
      meta = { 'mcp/www_authenticate': [challenge(ctx.env, [...new Set([...ctx.scopes, ...required])])] }
      throw new KtError('INSUFFICIENT_SCOPE')
    }
    await consumeRateLimit(
      ctx.env.DB,
      `mcp:${tool.write ? 'write' : 'read'}:${ctx.ownerId}`,
      tool.write ? 20 : 60,
      60,
      ctx.deps.now(),
    )
    const input = args ?? {}
    if (!tool.input.validate(input).valid) throw new KtError('INVALID_INPUT')
    const outcome = await tool.handler(input, ctx)
    envelope = {
      schema_version: '1',
      request_id: ctx.requestId,
      status: outcome.status ?? (outcome.data === null ? 'empty' : 'ok'),
      data: outcome.data,
      error: null,
      stale: outcome.stale ?? false,
      synced_at: outcome.syncedAt ?? null,
      next_cursor: outcome.nextCursor ?? null,
      persistence: tool.write ? 'committed' : 'not_applicable',
    }
    if (!tool.write) {
      if (findSecretPath(envelope.data))
        throw new KtError('SENSITIVE_PAYLOAD_BLOCKED', { category: 'output_scan' })
      if (byteLength(JSON.stringify(envelope)) > MAX_RESPONSE_BYTES) throw new KtError('RECORD_TOO_LARGE')
    }
    const check = tool.output.validate(envelope)
    if (!check.valid) {
      logEvent({ event: 'output_schema_mismatch', request_id: ctx.requestId, tool: name })
      // 写入已提交时不能改口说未提交；只读工具直接报错。
      if (!tool.write) throw new KtError('STORAGE_FAILED', { category: 'output_schema' })
    }
    const text = outcome.summary
    logEvent({
      event: 'tool',
      request_id: ctx.requestId,
      tool: name,
      duration_ms: Date.now() - started,
      status: envelope.status,
    })
    return {
      structuredContent: envelope as unknown as Record<string, unknown>,
      content: [{ type: 'text', text }],
    }
  } catch (error) {
    const kt =
      error instanceof KtError
        ? error
        : new KtError(tool.write ? 'COMMIT_STATUS_UNKNOWN' : 'STORAGE_FAILED', {
            persistence: tool.write ? 'unknown' : 'not_applicable',
            category: error instanceof Error ? error.name : 'unknown',
          })
    envelope = errorEnvelope(ctx.requestId, tool.write, kt)
    logEvent({
      event: 'tool',
      request_id: ctx.requestId,
      tool: name,
      duration_ms: Date.now() - started,
      status: 'error',
      code: kt.code,
      ...(kt.options.category ? { category: kt.options.category } : {}),
    })
    return {
      structuredContent: envelope as unknown as Record<string, unknown>,
      content: [{ type: 'text', text: errorText(tool.write, envelope) }],
      isError: true,
      ...(meta ? { _meta: meta } : {}),
    }
  }
}

// ───────────── Streamable HTTP（无状态、JSON 响应） ─────────────
// 不用 MCP SDK 的 Server/transport：SDK 1.30 在 server/index.js 静态引入 Ajv（含 new Function），
// 违反“无 eval 依赖”验收。协议面只有 initialize/ping/tools/list/tools/call + 通知，按 SDK 行为逐项对齐。
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const SERVER_INFO = { name: 'kinetrail', title: 'Kinetrail（身迹）', version: '0.1.0' }

type JsonRpcId = string | number

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

const rpcError = (id: JsonRpcId | null, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})

async function dispatch(
  message: unknown,
  registry: Map<string, RegisteredTool>,
  base: Omit<ToolContext, 'requestId'>,
): Promise<object | null> {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request')
  }
  const msg = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
  const hasId = typeof msg.id === 'string' || typeof msg.id === 'number'
  if (msg.jsonrpc !== '2.0') return rpcError(hasId ? (msg.id as JsonRpcId) : null, -32600, 'Invalid Request')
  if (typeof msg.method !== 'string') return null // 客户端发来的响应：无需回复
  if (!hasId) return null // 通知（如 notifications/initialized）
  const id = msg.id as JsonRpcId
  const params = (msg.params ?? {}) as Record<string, unknown>
  switch (msg.method) {
    case 'initialize': {
      const requested = params.protocolVersion
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0]
      return {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO },
      }
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: [...registry.values()].map((t) => t.descriptor) } }
    case 'tools/call': {
      if (typeof params.name !== 'string' || !registry.has(params.name))
        return rpcError(id, -32602, 'Unknown tool')
      const result = await callTool(registry, params.name, params.arguments, {
        ...base,
        requestId: crypto.randomUUID(),
      })
      return { jsonrpc: '2.0', id, result }
    }
    default:
      return rpcError(id, -32601, 'Method not found')
  }
}

export async function handleMcpRequest(
  request: Request,
  registry: Map<string, RegisteredTool>,
  base: Omit<ToolContext, 'requestId'>,
): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  const origin = request.headers.get('origin')
  if (origin && origin !== base.env.PUBLIC_ORIGIN)
    return jsonResponse(403, rpcError(null, -32600, 'Origin not allowed'))
  if (!ALL_SCOPES.some((s) => base.scopes.has(s))) {
    return jsonResponse(403, rpcError(null, -32600, 'Insufficient scope'), {
      'WWW-Authenticate': challenge(base.env, ['body:read', 'workout:read']),
    })
  }
  const accept = request.headers.get('accept') ?? ''
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    return jsonResponse(
      406,
      rpcError(
        null,
        -32000,
        'Not Acceptable: Client must accept both application/json and text/event-stream',
      ),
    )
  }
  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    return jsonResponse(
      415,
      rpcError(null, -32000, 'Unsupported Media Type: Content-Type must be application/json'),
    )
  }
  const version = request.headers.get('mcp-protocol-version')
  if (version !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return jsonResponse(400, rpcError(null, -32000, 'Bad Request: Unsupported protocol version'))
  }
  if (Number(request.headers.get('content-length') ?? '0') > MAX_REQUEST_BYTES) {
    return jsonResponse(413, rpcError(null, -32600, 'Request too large'))
  }
  try {
    // HTTP 层总限流：tools/list、initialize、ping 等不经过工具级限流的方法也计数。
    await consumeRateLimit(base.env.DB, `mcp:http:${base.ownerId}`, 120, 60, base.deps.now())
  } catch (error) {
    if (!(error instanceof KtError)) throw error
    return jsonResponse(429, rpcError(null, -32000, 'Rate limited'), {
      'Retry-After': String(error.options.retryAfterSeconds ?? 60),
    })
  }
  const bytes = await readBodyLimited(request.body, MAX_REQUEST_BYTES)
  if (bytes === null) return jsonResponse(413, rpcError(null, -32600, 'Request too large'))

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return jsonResponse(400, rpcError(null, -32700, 'Parse error: Invalid JSON'))
  }
  if (Array.isArray(parsed)) {
    // 批量只为兼容 2025-03-26 客户端保留，且限制条数、顺序执行、合计响应不超过单次上限，防止放大。
    if (parsed.length === 0 || parsed.length > MAX_BATCH) {
      return jsonResponse(400, rpcError(null, -32600, 'Invalid Request: batch size'))
    }
    const replies: object[] = []
    let total = 2
    for (const message of parsed) {
      const msg = message as { id?: unknown; method?: unknown; params?: { name?: unknown } } | null
      const id = typeof msg?.id === 'string' || typeof msg?.id === 'number' ? msg.id : null
      // 写工具不进批量：避免批量结果被整体丢弃时客户端拿不到已提交的收据而换键重试。
      if (msg?.method === 'tools/call' && registry.get(String(msg.params?.name))?.write) {
        if (id !== null) replies.push(rpcError(id, -32600, 'Write tools must be sent as individual requests'))
        continue
      }
      const reply = await dispatch(message, registry, base)
      if (reply === null) continue
      const size = byteLength(JSON.stringify(reply)) + 1
      if (total + size > MAX_RESPONSE_BYTES) {
        // 只读结果超出合计上限：该项改为错误，其余照常返回。
        replies.push(rpcError(id, -32000, 'Batch response too large; send this request individually'))
        continue
      }
      total += size
      replies.push(reply)
    }
    if (replies.length === 0) return new Response(null, { status: 202 })
    return jsonResponse(200, replies)
  }
  const reply = await dispatch(parsed, registry, base)
  return reply === null ? new Response(null, { status: 202 }) : jsonResponse(200, reply)
}
