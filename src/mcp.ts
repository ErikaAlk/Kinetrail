// Streamable HTTP（无状态、JSON 响应）+ 工具注册、scope、限流、输入/输出校验和统一信封。

import { Validator } from '@cfworker/json-schema'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  McpError,
  ErrorCode as RpcErrorCode,
} from '@modelcontextprotocol/sdk/types.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { consumeRateLimit } from './ratelimit'
import { findSecretPath } from './sanitize'
import { type ContractTool, contractTools, inlineRefs, type Scope } from './schemas'
import { byteLength, KtError, logEvent } from './util'

export const MAX_REQUEST_BYTES = 64 * 1024
export const MAX_RESPONSE_BYTES = 256 * 1024
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
  if (!tool) throw new McpError(RpcErrorCode.InvalidParams, 'Unknown tool')
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

const jsonError = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

export async function handleMcpRequest(
  request: Request,
  registry: Map<string, RegisteredTool>,
  base: Omit<ToolContext, 'requestId'>,
): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  const origin = request.headers.get('origin')
  if (origin && origin !== base.env.PUBLIC_ORIGIN) return jsonError(403, -32600, 'Origin not allowed')
  if (!ALL_SCOPES.some((s) => base.scopes.has(s))) {
    return jsonError(403, -32600, 'Insufficient scope', {
      'WWW-Authenticate': challenge(base.env, ['body:read', 'workout:read']),
    })
  }
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_REQUEST_BYTES) return jsonError(413, -32600, 'Request too large')
  const body = await readLimited(request, MAX_REQUEST_BYTES)
  if (body === null) return jsonError(413, -32600, 'Request too large')

  const server = new Server(
    { name: 'kinetrail', version: '0.1.0' },
    { capabilities: { tools: {} }, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...registry.values()].map((t) => t.descriptor) as never,
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callTool(registry, req.params.name, req.params.arguments, { ...base, requestId: crypto.randomUUID() }),
  )
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(
      new Request(request.url, { method: 'POST', headers: request.headers, body }),
    )
  } finally {
    await server.close()
  }
}

async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
