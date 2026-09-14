// 跨模块共用：稳定错误码、摘要/签名、无损 JSON、时区日历、脱敏日志。

export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

// ───────────── 错误 ─────────────
const MESSAGES = {
  AUTH_REQUIRED: '需要重新授权 Kinetrail。',
  INSUFFICIENT_SCOPE: '当前授权缺少此操作所需的权限，请重新授权。',
  NOT_FOUND: '没有找到对应的记录。',
  PROFILE_REQUIRED: '账户下有多个成员，请指定 profile_ref。',
  NEEDS_CLARIFICATION: '内容可能是计划、建议、假设或未完成的训练，请先向用户确认已经完成。',
  INVALID_RANGE: '查询范围无效或过大，请缩小范围或分段查询。',
  INVALID_UNIT: '单位缺失或不受支持。',
  INVALID_INPUT: '输入不符合契约。',
  SESSION_AMBIGUOUS: '存在多个未结束的训练会话，请指定 session_id。',
  SESSION_SELECTION_REQUIRED: '无法自动确定训练会话，请先查询 open 会话并指定 session_id。',
  SESSION_FINALIZED: '该训练会话已结束，继续记录前需要显式重新打开或新建会话。',
  REVISION_CONFLICT: '会话版本已变化，请先读回最新状态再决定是否写入。',
  IDEMPOTENCY_CONFLICT: '同一个 idempotency_key 已用于不同的请求内容。',
  CURSOR_INVALID: '分页游标无效，请从第一页重新查询。',
  CURSOR_EXPIRED: '分页游标已过期，请从第一页重新查询。',
  RECORD_TOO_LARGE: '单条记录超过响应上限，请按 chunk 读取。',
  RATE_LIMITED: '请求过于频繁，请稍后再试。',
  SYNC_IN_PROGRESS: '同步正在进行或处于冷却期。',
  FITDAYS_LOGIN_FAILED: 'FitDays 登录失败或凭据未配置。',
  UPSTREAM_TIMEOUT: 'FitDays 响应超时。',
  UPSTREAM_ROUTE_DENIED: 'FitDays 返回了未经审核的跳转，已拒绝访问。',
  SENSITIVE_PAYLOAD_BLOCKED: '响应含疑似敏感内容，已阻断。',
  INCOMPLETE_SYNC: '同步未完整完成。',
  STORAGE_FAILED: '数据库操作失败。',
  COMMIT_STATUS_UNKNOWN: '无法确认是否已提交，请用同一个 idempotency_key 查询收据。',
} as const

export type ErrorCode = keyof typeof MESSAGES
export type ErrorPersistence = 'not_applicable' | 'not_committed' | 'unknown'

export interface KtErrorOptions {
  retryable?: boolean
  persistence?: ErrorPersistence
  currentRevision?: number
  retryAfterSeconds?: number
  /** 仅供服务端日志的非敏感类别，永不进入工具输出。 */
  category?: string
}

export class KtError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly options: KtErrorOptions = {},
  ) {
    super(code)
    this.name = 'KtError'
  }
  get userMessage(): string {
    return MESSAGES[this.code]
  }
}

// ───────────── 摘要、编码 ─────────────
export const encoder = new TextEncoder()
export const byteLength = (text: string): number => encoder.encode(text).byteLength

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

export const randomToken = (size = 32): string => b64url(crypto.getRandomValues(new Uint8Array(size)))

/** 按字节上限读取请求/响应体；超限时取消读取并返回 null。 */
export async function readBodyLimited(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
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
  return bytes
}

export async function hmacSha256(key: string, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)))
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  let diff = left.length ^ right.length
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  return diff === 0
}

// ───────────── 无损 JSON ─────────────
// JSON.parse 的 reviver context.source + JSON.rawJSON 保留数字原始词法（Node 22 / workerd 已实测）。
export interface RawNumber {
  readonly rawJSON: string
}
interface JsonWithRaw {
  rawJSON(text: string): RawNumber
  isRawJSON(value: unknown): value is RawNumber
  parse(
    text: string,
    reviver: (key: string, value: unknown, context: { source?: string }) => unknown,
  ): unknown
}
const LosslessJSON = JSON as unknown as JsonWithRaw

export const parseLossless = (text: string): unknown =>
  LosslessJSON.parse(text, (_key, value, context) =>
    typeof value === 'number' && context.source !== undefined ? LosslessJSON.rawJSON(context.source) : value,
  )

export const isRawNumber = (value: unknown): value is RawNumber => LosslessJSON.isRawJSON(value)

/** 按键排序的紧凑序列化，用于内容哈希与幂等 payload 哈希。数字保持原词法。 */
export function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (value !== null && typeof value === 'object' && !isRawNumber(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// ───────────── 时间与日历 ─────────────
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

/** 仅接受带时区偏移的 RFC3339，返回 UTC 毫秒；服务端不猜宿主时区。 */
export function parseInstant(text: string): number | null {
  const m = RFC3339.exec(text)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number]
  const frac = m[7] ? Math.floor(Number(`0${m[7]}`) * 1000) : 0
  const base = Date.UTC(y, mo - 1, d, h, mi, s, frac)
  const check = new Date(base)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  if (h > 23 || mi > 59 || s > 59) return null
  const zone = m[8] as string
  if (zone === 'Z') return base
  const sign = zone.startsWith('-') ? -1 : 1
  const [oh, om] = zone.slice(1).split(':').map(Number) as [number, number]
  if (oh > 23 || om > 59) return null
  return base - sign * (oh * 60 + om) * 60_000
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(tz, f)
  }
  return f
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

function zonedParts(ms: number, tz: string) {
  const out: Record<string, number> = {}
  for (const p of formatter(tz).formatToParts(new Date(ms)))
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number }
}

export function tzOffsetMinutes(ms: number, tz: string): number {
  const p = zonedParts(ms, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000)
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

export function localDate(ms: number, tz: string): string {
  const p = zonedParts(ms, tz)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
}

/** 本地日期 00:00 对应的 UTC 毫秒（两次偏移迭代，覆盖夏令时切换日）。 */
export function zonedMidnight(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const guess = Date.UTC(y, m - 1, d)
  const first = guess - tzOffsetMinutes(guess, tz) * 60_000
  return guess - tzOffsetMinutes(first, tz) * 60_000
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** UTC 毫秒 → 带目标时区偏移的 RFC3339（秒精度）。 */
export function isoInZone(ms: number, tz: string): string {
  const p = zonedParts(ms, tz)
  const offset = tzOffsetMinutes(ms, tz)
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

// ───────────── 日志 ─────────────
export interface LogFields {
  event: string
  request_id?: string
  tool?: string
  duration_ms?: number
  count?: number
  status?: string
  code?: string
  category?: string
}

/** 唯一日志出口：只接受白名单字段，不接受任意对象、URL、body 或错误实例。 */
export function logEvent(fields: LogFields): void {
  // biome-ignore lint/suspicious/noConsole: 结构化脱敏日志唯一出口
  console.log(JSON.stringify(fields))
}
