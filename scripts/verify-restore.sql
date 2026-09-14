-- 在“恢复出来的隔离数据库”上执行，与备份时的线上计数对照。全部为只读查询。
-- npx wrangler d1 execute <restore-db> --remote --file scripts/verify-restore.sql

-- D1 限制 compound SELECT 项数，这里用单个 SELECT + 标量子查询。
SELECT
  (SELECT COUNT(*) FROM raw_records) AS raw_records,
  (SELECT COUNT(*) FROM raw_record_versions WHERE published = 1) AS raw_versions_published,
  (SELECT COUNT(*) FROM raw_chunks) AS raw_chunks,
  (SELECT COUNT(*) FROM workout_sessions) AS workout_sessions,
  (SELECT COUNT(*) FROM workout_events) AS workout_events,
  (SELECT COUNT(*) FROM workout_entry_versions) AS workout_entry_versions,
  (SELECT COUNT(*) FROM write_receipts) AS write_receipts,
  (SELECT COUNT(*) FROM sync_batches) AS sync_batches;

-- 应为 0：分块数与 chunk_count 不一致的版本
SELECT 'chunk_count_mismatch' AS item, COUNT(*) AS n FROM raw_record_versions v
WHERE v.raw_json IS NULL AND v.chunk_count != (SELECT COUNT(*) FROM raw_chunks c WHERE c.version_id = v.id);

-- 应为 0：收据找不到对应事件（写入收据与事件同事务提交）
SELECT 'receipt_without_event' AS item, COUNT(*) AS n FROM write_receipts r
WHERE NOT EXISTS (SELECT 1 FROM workout_events e WHERE e.owner_id = r.owner_id AND e.idempotency_key = r.idempotency_key);

-- 应为 0：会话 revision 与其事件链最大 resulting_revision 不一致
SELECT 'session_revision_mismatch' AS item, COUNT(*) AS n FROM workout_sessions s
WHERE s.revision != (SELECT MAX(e.resulting_revision) FROM workout_events e WHERE e.session_id = s.id);

-- 应为 0：条目版本号不连续
SELECT 'entry_version_gap' AS item, COUNT(*) AS n FROM workout_entry_versions v
WHERE v.version > 1 AND NOT EXISTS (
  SELECT 1 FROM workout_entry_versions p WHERE p.entry_id = v.entry_id AND p.version = v.version - 1);

-- 最近发布批次（与线上 get_sync_status 对照）
SELECT id, mode, state, coverage, finished_at FROM sync_batches ORDER BY created_at DESC LIMIT 3;
