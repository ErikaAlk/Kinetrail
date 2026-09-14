// 签名 keyset 游标：绑定 owner、工具、查询参数哈希、快照 generation 与过期时间。禁止裸 OFFSET。

import {
  b64url,
  canonicalStringify,
  constantTimeEqual,
  fromB64url,
  hmacSha256,
  KtError,
  sha256Hex,
} from './util'

export const CURSOR_TTL_MS = 3600_000

export interface CursorState {
  /** 快照：测量为 published generation，训练为 as_of 毫秒。 */
  snapshot: number
  /** 上一页最后一行的排序键。 */
  key: (string | number)[]
}

interface Payload extends CursorState {
  tool: string
  query: string
  exp: number
}

function signingKey(env: Env): string {
  const key = env.CURSOR_SIGNING_KEY
  if (!key || key.length < 32) throw new KtError('STORAGE_FAILED', { category: 'cursor_key_missing' })
  return key
}

export async function queryHash(
  args: Record<string, unknown>,
  ignore: string[] = ['cursor'],
): Promise<string> {
  const filtered = Object.fromEntries(Object.entries(args).filter(([k]) => !ignore.includes(k)))
  return (await sha256Hex(canonicalStringify(filtered))).slice(0, 32)
}

export async function encodeCursor(
  env: Env,
  ownerId: string,
  tool: string,
  query: string,
  state: CursorState,
  nowMs: number,
): Promise<string> {
  const payload: Payload = { ...state, tool, query, exp: nowMs + CURSOR_TTL_MS }
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = b64url(await hmacSha256(signingKey(env), `${ownerId}.${body}`))
  return `${body}.${sig}`
}

export async function decodeCursor(
  env: Env,
  ownerId: string,
  tool: string,
  query: string,
  cursor: string,
  nowMs: number,
): Promise<CursorState> {
  const [body, sig, extra] = cursor.split('.')
  if (!body || !sig || extra !== undefined) throw new KtError('CURSOR_INVALID')
  const expected = b64url(await hmacSha256(signingKey(env), `${ownerId}.${body}`))
  if (!constantTimeEqual(sig, expected)) throw new KtError('CURSOR_INVALID')
  let payload: Payload
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Payload
  } catch {
    throw new KtError('CURSOR_INVALID')
  }
  if (payload.tool !== tool || payload.query !== query || !Array.isArray(payload.key)) {
    throw new KtError('CURSOR_INVALID')
  }
  if (payload.exp < nowMs) throw new KtError('CURSOR_EXPIRED')
  return { snapshot: payload.snapshot, key: payload.key }
}
