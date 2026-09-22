-- 手机上物理删除称重（2026-09-22，用户要求）。事实表仍然默认禁止删除：只有本次删除在同一个 D1 batch 里
-- 先写入 purge_authorizations 的那条 raw_record，触发器才放行；batch 末尾删掉授权行。代码里别处误删照旧被拒。

CREATE TABLE purge_authorizations (raw_record_id TEXT PRIMARY KEY);

-- 墓碑：只存来源键的哈希与删除时刻，不存读数。挡住手机重读 Health Connect、网关重发把删掉的称重写回来。
CREATE TABLE deleted_measurements (
  owner_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, key_hash)
);

DROP TRIGGER raw_records_no_delete;
CREATE TRIGGER raw_records_no_delete BEFORE DELETE ON raw_records
WHEN NOT EXISTS (SELECT 1 FROM purge_authorizations WHERE raw_record_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'raw_records are append-only'); END;

DROP TRIGGER rrv_published_no_delete;
CREATE TRIGGER rrv_published_no_delete BEFORE DELETE ON raw_record_versions
WHEN OLD.published = 1 AND NOT EXISTS (SELECT 1 FROM purge_authorizations WHERE raw_record_id = OLD.raw_record_id)
BEGIN SELECT RAISE(ABORT, 'published raw versions are immutable'); END;
