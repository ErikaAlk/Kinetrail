// 手机上物理删除一次称重（DATA_CONTRACT 第 11 节）：限流 → 手机令牌 → 有界读取 → 严格校验 →
// 在 sync_lease 内用单个 D1 batch 删掉这条 raw_record 的全部版本与分块，写墓碑挡住重推。
// 只删本人、dataset=weight、来自 Health Connect 推送或体脂秤网关的记录。旧 FitDays 记录连着阻抗等关联记录，
// 关联规则还没验证（measurements.ts 的 JOIN_RULES_VERIFIED），不开放。

import { Validator } from '@cfworker/json-schema'
import type { Deps } from './mcp'
import { consumeRateLimit } from './ratelimit'
import { acquireLease } from './sync'
import { constantTimeEqual, KtError, logEvent, readBodyLimited, sha256Hex } from './util'

export const DELETE_PATH = '/app/measurements/delete'
/** 能在手机上删的来源：Health Connect 推送（hc:）与体脂秤网关（ble:）。 */
export const DELETABLE_SOURCE = /^(hc|ble):/
const MAX_BODY_BYTES = 1024
const RATE_LIMIT_PER_IP_PER_MINUTE = 20
// 全局上限：令牌泄漏时一分钟最多删 10 条，给发现和轮换令牌留出时间。
const RATE_LIMIT_GLOBAL_PER_MINUTE = 10

const validator = new Validator(
  {
    type: 'object',
    additionalProperties: false,
    required: ['record_id'],
    properties: {
      record_id: {
        type: 'string',
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      },
    },
  },
  '2020-12',
  false,
)

/** 墓碑键：来源键的哈希，前面带编码版本。不存读数；时间型来源键可以被枚举，所以它不算匿名化。 */
export const tombstoneHash = (dataset: string, profileRef: string, sourceRecordId: string) =>
  sha256Hex(JSON.stringify(['v1', dataset, profileRef, sourceRecordId]))

/** 已被物理删除的来源键（在 sourceIds 里的那部分）。 */
export async function deletedSources(
  db: D1Database,
  ownerId: string,
  dataset: string,
  profileRef: string,
  sourceIds: string[],
): Promise<Set<string>> {
  if (sourceIds.length === 0) return new Set()
  const hashes = await Promise.all(sourceIds.map((id) => tombstoneHash(dataset, profileRef, id)))
  const rows = await db
    .prepare(
      'SELECT key_hash FROM deleted_measurements WHERE owner_id = ?1 AND key_hash IN (SELECT value FROM json_each(?2))',
    )
    .bind(ownerId, JSON.stringify(hashes))
    .all<{ key_hash: string }>()
  const hit = new Set(rows.results.map((r) => r.key_hash))
  return new Set(sourceIds.filter((_, i) => hit.has(hashes[i] as string)))
}

export type DeleteOutcome = 'deleted' | 'not_found' | 'not_deletable' | 'busy'

export async function deleteMeasurement(
  db: D1Database,
  ownerId: string,
  profileRef: string,
  recordId: string,
  nowMs: number,
): Promise<DeleteOutcome> {
  const holder = crypto.randomUUID()
  const generation = await acquireLease(db, ownerId, holder, nowMs)
  if (generation === null) return 'busy'
  const release = () =>
    db
      .prepare(
        'UPDATE sync_lease SET holder = NULL, expires_at = 0 WHERE owner_id = ? AND generation = ? AND holder = ?',
      )
      .bind(ownerId, generation, holder)
  try {
    // 在 lease 内读：推送不能在查完之后、删除之前给这条记录加新版本。
    const row = await db
      .prepare('SELECT dataset, profile_ref, source_record_id FROM raw_records WHERE id = ? AND owner_id = ?')
      .bind(recordId, ownerId)
      .first<{ dataset: string; profile_ref: string; source_record_id: string }>()
    if (row?.dataset !== 'weight' || row.profile_ref !== profileRef) {
      await release().run()
      return 'not_found'
    }
    if (!DELETABLE_SOURCE.test(row.source_record_id)) {
      await release().run()
      return 'not_deletable'
    }
    const keyHash = await tombstoneHash(row.dataset, row.profile_ref, row.source_record_id)
    await db.batch([
      db
        .prepare(
          `INSERT INTO guard (ok) SELECT NULL WHERE NOT EXISTS
           (SELECT 1 FROM sync_lease WHERE owner_id = ? AND generation = ? AND holder = ?)`,
        )
        .bind(ownerId, generation, holder),
      // 触发器只放行 purge_authorizations 里的记录；授权行在同一个 batch 末尾删掉。
      db.prepare('INSERT INTO purge_authorizations (raw_record_id) VALUES (?)').bind(recordId),
      db
        .prepare(
          'DELETE FROM raw_chunks WHERE version_id IN (SELECT id FROM raw_record_versions WHERE raw_record_id = ?)',
        )
        .bind(recordId),
      db.prepare('DELETE FROM raw_record_versions WHERE raw_record_id = ?').bind(recordId),
      db.prepare('DELETE FROM raw_records WHERE id = ? AND owner_id = ?').bind(recordId, ownerId),
      db
        .prepare(
          'INSERT OR IGNORE INTO deleted_measurements (owner_id, key_hash, deleted_at) VALUES (?, ?, ?)',
        )
        .bind(ownerId, keyHash, nowMs),
      db.prepare('DELETE FROM purge_authorizations WHERE raw_record_id = ?').bind(recordId),
      release(),
    ])
    return 'deleted'
  } catch (error) {
    await release()
      .run()
      .catch(() => {})
    throw error
  }
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })

export async function handleDelete(request: Request, env: Env, deps: Deps): Promise<Response> {
  const expected = env.HC_INGEST_TOKEN_SHA256?.trim().toLowerCase()
  // 未配置令牌或方法不对时与不存在的路径表现一致。
  if (request.method !== 'POST' || !expected) return new Response('Not found', { status: 404 })
  const started = deps.now()
  try {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    await consumeRateLimit(env.DB, `delete:${ip}`, RATE_LIMIT_PER_IP_PER_MINUTE, 60, started)

    const header = request.headers.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!token || !constantTimeEqual(await sha256Hex(token), expected)) {
      logEvent({ event: 'delete', status: 'unauthorized' })
      return reply(401, { error: 'unauthorized' })
    }
    // 全局计数放在鉴权之后：未授权的请求再多也挤不掉本人设备的额度。
    await consumeRateLimit(env.DB, 'delete:all', RATE_LIMIT_GLOBAL_PER_MINUTE, 60, started)
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return reply(415, { error: 'unsupported_media_type' })
    }
    const bytes = await readBodyLimited(request.body, MAX_BODY_BYTES)
    if (!bytes) return reply(413, { error: 'payload_too_large' })
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
    } catch {
      return reply(400, { error: 'invalid_json' })
    }
    if (!validator.validate(payload).valid) return reply(400, { error: 'invalid_payload' })
    if (!env.HC_PROFILE_REF) return reply(503, { error: 'not_configured' })

    const outcome = await deleteMeasurement(
      env.DB,
      env.OWNER_ID,
      env.HC_PROFILE_REF,
      (payload as { record_id: string }).record_id,
      started,
    )
    logEvent({ event: 'delete', status: outcome, duration_ms: deps.now() - started })
    switch (outcome) {
      case 'deleted':
        return reply(200, { deleted: true })
      case 'not_found':
        return reply(404, { error: 'not_found' })
      case 'not_deletable':
        return reply(409, { error: 'not_deletable' })
      case 'busy':
        return reply(503, { error: 'busy' }, { 'retry-after': '10' })
    }
  } catch (error) {
    if (error instanceof KtError && error.code === 'RATE_LIMITED') {
      return reply(
        429,
        { error: 'rate_limited' },
        { 'retry-after': String(error.options.retryAfterSeconds ?? 60) },
      )
    }
    logEvent({
      event: 'delete',
      status: 'failed',
      code: error instanceof KtError ? error.code : 'STORAGE_FAILED',
      category: error instanceof Error ? error.name : 'unknown',
    })
    return reply(500, { error: 'storage_failed' })
  }
}
