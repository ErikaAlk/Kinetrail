-- 一次性清理（2026-09-15，用户明确要求“只存我自己的，其他人的数据都删掉”）。
-- 删除 PROFILE_ALLOWLIST（p_914ea14c79915f2f）之外全部成员的测量数据与昵称，包括无 suid 的 p_unknown。
-- 不可撤销：D1 Time Travel 保留期内仍有历史副本，到期后才消失。
-- 可重复执行：中途失败时整份重跑；最后必须看到两个禁止删除触发器都存在。
-- 执行前确认没有 staging 中的同步批次，且已部署带 PROFILE_ALLOWLIST 的版本（否则下次同步会重新拉回）。

DROP TRIGGER IF EXISTS raw_records_no_delete;
DROP TRIGGER IF EXISTS rrv_published_no_delete;

DELETE FROM raw_chunks
WHERE version_id IN (
  SELECT id FROM raw_record_versions WHERE owner_id = 'owner' AND profile_ref != 'p_914ea14c79915f2f'
);
DELETE FROM raw_record_versions WHERE owner_id = 'owner' AND profile_ref != 'p_914ea14c79915f2f';
DELETE FROM raw_records WHERE owner_id = 'owner' AND profile_ref != 'p_914ea14c79915f2f';
DELETE FROM profiles WHERE owner_id = 'owner' AND profile_ref != 'p_914ea14c79915f2f';

CREATE TRIGGER IF NOT EXISTS raw_records_no_delete BEFORE DELETE ON raw_records
BEGIN SELECT RAISE(ABORT, 'raw_records are append-only'); END;

CREATE TRIGGER IF NOT EXISTS rrv_published_no_delete BEFORE DELETE ON raw_record_versions WHEN OLD.published = 1
BEGIN SELECT RAISE(ABORT, 'published raw versions are immutable'); END;
