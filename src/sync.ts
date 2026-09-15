// 同步任务：持久化 job（sync_batches）+ D1 lease/fencing。refresh_data 只排队并尽力立即执行，
// 定时调度（SyncScheduler alarm / cron）负责补偿未完成任务与定期刷新；不依赖孤立的 waitUntil 保证完成。

import {
  envSecrets,
  fetchSyncWindows,
  fitdaysConfigured,
  type SecretReader,
  type SyncWindow,
} from './fitdays'
import type { Deps } from './mcp'
import {
  failBatch,
  type PreparedBatch,
  prepareWindows,
  publishBatch,
  purgeFailedStaging,
  stageBatch,
} from './measurements'
import { KtError, logEvent, parseInstant } from './util'

// ponytail: 以下策略值待真实 CN 数据（G1）校准。
export const SYNC_POLICY = {
  incrementalCooldownMs: 60_000,
  /** 首次全量（含失败或 partial 后重试）的冷却：足够排查凭据问题，又不会反复全量拉取。 */
  initialFullCooldownMs: 10 * 60_000,
  fullCooldownMs: 24 * 3600_000,
  leaseMs: 180_000,
  overlapSeconds: 7 * 86_400,
  windowSeconds: 180 * 86_400,
  windowOverlapSeconds: 86_400,
  futureSkewSeconds: 86_400,
  maxAttempts: 3,
  periodicIncrementalMs: 6 * 3600_000,
  periodicFullMs: 7 * 86_400_000,
  staleAfterMs: 15 * 60_000,
}

type Mode = 'initial_full' | 'incremental' | 'reconciliation_full'

export interface JobView {
  job_id: string
  state: 'queued' | 'running' | 'completed'
  coverage: 'unknown' | 'partial' | 'verified_window'
}

interface BatchRow {
  id: string
  mode: Mode
  state: string
  coverage: JobView['coverage']
  created_at: number
  attempts: number
}

const viewOf = (row: Pick<BatchRow, 'id' | 'state' | 'coverage'>): JobView => ({
  job_id: row.id,
  state: row.state === 'queued' ? 'queued' : row.state === 'staging' ? 'running' : 'completed',
  coverage: row.coverage,
})

export async function requestRefresh(
  db: D1Database,
  ownerId: string,
  requested: 'incremental' | 'full',
  nowMs: number,
): Promise<JobView> {
  const active = await db
    .prepare(
      "SELECT id, state, coverage FROM sync_batches WHERE owner_id = ? AND state IN ('queued', 'staging') ORDER BY created_at DESC LIMIT 1",
    )
    .bind(ownerId)
    .first<BatchRow>()
  if (active) return viewOf(active)

  const meta = await db
    .prepare('SELECT checkpoint_newest FROM sync_meta WHERE owner_id = ?')
    .bind(ownerId)
    .first<{ checkpoint_newest: number | null }>()
  const hasCheckpoint = meta?.checkpoint_newest != null
  // 冷却按“实际执行的模式”计算：没有检查点时 incremental 也会变成全量，不能只看 incremental 的冷却。
  const mode: Mode = !hasCheckpoint
    ? 'initial_full'
    : requested === 'full'
      ? 'reconciliation_full'
      : 'incremental'
  const last = await db
    .prepare(
      `SELECT created_at FROM sync_batches WHERE owner_id = ? AND ${mode === 'incremental' ? "mode = 'incremental'" : "mode != 'incremental'"}
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(ownerId)
    .first<{ created_at: number }>()
  const cooldown =
    mode === 'incremental'
      ? SYNC_POLICY.incrementalCooldownMs
      : mode === 'initial_full'
        ? SYNC_POLICY.initialFullCooldownMs
        : SYNC_POLICY.fullCooldownMs
  if (last && nowMs - last.created_at < cooldown) {
    throw new KtError('SYNC_IN_PROGRESS', {
      retryable: true,
      retryAfterSeconds: Math.ceil((cooldown - (nowMs - last.created_at)) / 1000),
      category: 'cooldown',
    })
  }
  const id = crypto.randomUUID()
  await db
    .prepare("INSERT INTO sync_batches (id, owner_id, mode, state, created_at) VALUES (?, ?, ?, 'queued', ?)")
    .bind(id, ownerId, mode, nowMs)
    .run()
  return { job_id: id, state: 'queued', coverage: 'unknown' }
}

export function planWindows(
  mode: Mode,
  nowSeconds: number,
  historyStart: number,
  checkpoint: number | null,
): SyncWindow[] {
  const newest = nowSeconds + SYNC_POLICY.futureSkewSeconds
  const oldest =
    mode === 'incremental' && checkpoint !== null
      ? Math.max(historyStart, checkpoint - SYNC_POLICY.overlapSeconds)
      : historyStart
  const windows: SyncWindow[] = []
  for (let top = newest; top > oldest; top -= SYNC_POLICY.windowSeconds) {
    windows.push({
      newest: top,
      oldest: Math.max(oldest, top - SYNC_POLICY.windowSeconds - SYNC_POLICY.windowOverlapSeconds),
    })
  }
  return windows
}

async function acquireLease(
  db: D1Database,
  ownerId: string,
  holder: string,
  nowMs: number,
): Promise<number | null> {
  await db.prepare('INSERT OR IGNORE INTO sync_lease (owner_id) VALUES (?)').bind(ownerId).run()
  const row = await db
    .prepare(
      `UPDATE sync_lease SET generation = generation + 1, holder = ?1, expires_at = ?2
       WHERE owner_id = ?3 AND (holder IS NULL OR expires_at < ?4) RETURNING generation`,
    )
    .bind(holder, nowMs + SYNC_POLICY.leaseMs, ownerId, nowMs)
    .first<{ generation: number }>()
  return row?.generation ?? null
}

export interface RunOptions {
  secrets?: SecretReader
  /** 仅测试：发布前注入故障，验证未发布暂存不可见。 */
  beforePublish?: (prepared: PreparedBatch) => Promise<void>
}

/** 执行一个排队的同步任务。拿不到 lease 时直接返回，任务留在队列由定时调度补偿。 */
export async function runSyncJob(
  env: Env,
  batchId: string,
  deps: Deps,
  options: RunOptions = {},
): Promise<void> {
  const db = env.DB
  const batch = await db
    .prepare('SELECT id, owner_id, mode, state, attempts FROM sync_batches WHERE id = ?')
    .bind(batchId)
    .first<BatchRow & { owner_id: string }>()
  if (batch?.state !== 'queued') return
  const ownerId = batch.owner_id
  const started = deps.now()
  const generation = await acquireLease(db, ownerId, batchId, started)
  if (generation === null) return
  const claimed = await db
    .prepare(
      "UPDATE sync_batches SET state = 'staging', generation = ?, started_at = ?, attempts = attempts + 1 WHERE id = ? AND state = 'queued'",
    )
    .bind(generation, started, batchId)
    .run()
  if (claimed.meta.changes !== 1) {
    await db
      .prepare('UPDATE sync_lease SET holder = NULL, expires_at = 0 WHERE owner_id = ? AND generation = ?')
      .bind(ownerId, generation)
      .run()
    return
  }

  try {
    const meta = await db
      .prepare('SELECT checkpoint_newest FROM sync_meta WHERE owner_id = ?')
      .bind(ownerId)
      .first<{ checkpoint_newest: number | null }>()
    const historyStartMs = parseInstant(env.FITDAYS_HISTORY_START)
    if (historyStartMs === null) throw new KtError('INCOMPLETE_SYNC', { category: 'history_start_invalid' })
    const nowSeconds = Math.floor(started / 1000)
    const windows = planWindows(
      batch.mode,
      nowSeconds,
      Math.floor(historyStartMs / 1000),
      meta?.checkpoint_newest ?? null,
    )
    const secrets = options.secrets ?? envSecrets(env)
    const fetched = await fetchSyncWindows(secrets, windows, deps)
    const prepared = await prepareWindows(fetched.windows, fetched.knownSecrets)
    fetched.knownSecrets.clear()

    const staged = await stageBatch(db, ownerId, batchId, generation, prepared, deps.now())
    const state = prepared.partial ? 'partial' : 'published'
    const coverage = prepared.partial ? 'partial' : 'unknown'
    const counts = Object.fromEntries(
      ['weight', 'impedance', 'hr', 'balance', 'gravity', 'height', 'rulers', 'skip'].map((d) => [
        d,
        prepared.records.filter((r) => r.dataset === d).length,
      ]),
    )
    await db
      .prepare(
        `UPDATE sync_batches SET requested_oldest = ?, requested_newest = ?, source_region = ?, coverage = ?,
           manifest_json = ?, counts_json = ?, projections_json = ? WHERE id = ?`,
      )
      .bind(
        windows.at(-1)?.oldest ?? null,
        windows[0]?.newest ?? null,
        fetched.region,
        coverage,
        JSON.stringify(prepared.manifests),
        JSON.stringify({ ...counts, blocked: prepared.blocked.length, versions: staged.versionCount }),
        JSON.stringify({ profiles: prepared.profiles.length, devices: prepared.devices.length }),
        batchId,
      )
      .run()
    await options.beforePublish?.(prepared)
    await publishBatch(db, {
      ownerId,
      batchId,
      generation,
      state,
      mode: batch.mode,
      // partial 批次不推进增量检查点，下一次仍从上个完整批次开始重叠拉取。
      checkpointNewest: prepared.partial ? null : nowSeconds,
      seenRecordIds: [...staged.unchangedRecordIds, ...staged.touchedRecordIds],
      prepared,
      nowMs: deps.now(),
    })
    logEvent({ event: 'sync', status: state, duration_ms: deps.now() - started, count: staged.versionCount })
  } catch (error) {
    const code = error instanceof KtError ? error.code : 'STORAGE_FAILED'
    const category =
      error instanceof KtError ? error.options.category : error instanceof Error ? error.name : 'unknown'
    logEvent({
      event: 'sync',
      status: 'failed',
      code,
      duration_ms: deps.now() - started,
      ...(category ? { category } : {}),
    })
    await failBatch(db, ownerId, batchId, generation, code, deps.now())
  }
}

/** 定时调度入口：回收过期暂存、执行排队任务、按周期发起刷新。 */
export async function scheduledSync(env: Env, deps: Deps, options: RunOptions = {}): Promise<void> {
  const db = env.DB
  const now = deps.now()
  const expired = await db
    .prepare(
      `SELECT b.id, b.mode, b.attempts, b.owner_id, b.generation FROM sync_batches b JOIN sync_lease l ON l.owner_id = b.owner_id
       WHERE b.state = 'staging' AND (l.holder IS NULL OR l.holder != b.id OR l.expires_at < ?)`,
    )
    .bind(now)
    .all<{ id: string; mode: Mode; attempts: number; owner_id: string; generation: number }>()
  for (const row of expired.results) {
    await failBatch(db, row.owner_id, row.id, row.generation, 'INCOMPLETE_SYNC', now)
    if (row.attempts < SYNC_POLICY.maxAttempts) {
      // 重试用新的 batch_id：被截断的旧尝试即使还在跑，也无法发布或清理新尝试的暂存。
      await db
        .prepare(
          "INSERT INTO sync_batches (id, owner_id, mode, state, attempts, created_at) VALUES (?, ?, ?, 'queued', ?, ?)",
        )
        .bind(crypto.randomUUID(), row.owner_id, row.mode, row.attempts, now)
        .run()
    }
  }
  await purgeFailedStaging(db)

  const secrets = options.secrets ?? envSecrets(env)
  if (!fitdaysConfigured(secrets)) return
  const queued = await db
    .prepare(
      "SELECT id FROM sync_batches WHERE owner_id = ? AND state = 'queued' ORDER BY created_at LIMIT 1",
    )
    .bind(env.OWNER_ID)
    .first<{ id: string }>()
  if (queued) return runSyncJob(env, queued.id, deps, options)

  const meta = await db
    .prepare('SELECT last_attempt_at, last_full_at FROM sync_meta WHERE owner_id = ?')
    .bind(env.OWNER_ID)
    .first<{ last_attempt_at: number | null; last_full_at: number | null }>()
  const dueFull = !meta?.last_full_at || now - meta.last_full_at > SYNC_POLICY.periodicFullMs
  const dueIncremental =
    !meta?.last_attempt_at || now - meta.last_attempt_at > SYNC_POLICY.periodicIncrementalMs
  if (!dueFull && !dueIncremental) return
  try {
    const job = await requestRefresh(db, env.OWNER_ID, dueFull ? 'full' : 'incremental', now)
    await runSyncJob(env, job.job_id, deps, options)
  } catch (error) {
    if (!(error instanceof KtError && error.code === 'SYNC_IN_PROGRESS')) throw error
  }
}
