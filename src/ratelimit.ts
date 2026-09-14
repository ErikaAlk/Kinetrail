import { KtError } from './util'

/** D1 原子固定窗口计数；不使用最终一致的 KV。超限抛 RATE_LIMITED。 */
export async function consumeRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowSeconds: number,
  nowMs: number,
): Promise<void> {
  const nowSeconds = Math.floor(nowMs / 1000)
  const windowStart = nowSeconds - (nowSeconds % windowSeconds)
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>()
  if ((row?.count ?? 0) > limit) {
    throw new KtError('RATE_LIMITED', {
      retryable: true,
      retryAfterSeconds: windowStart + windowSeconds - nowSeconds,
    })
  }
}

export const purgeRateLimits = (db: D1Database, nowMs: number) =>
  db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(Math.floor(nowMs / 1000) - 3600)
    .run()
