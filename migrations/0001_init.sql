-- Kinetrail v1 schema。事实表禁止物理删除和就地修改，由触发器在数据库层强制。

-- CAS 守卫：`INSERT INTO guard(ok) SELECT NULL WHERE <冲突条件>` 在冲突时触发 NOT NULL 约束，
-- 使整个 D1 batch 回滚。条件不成立时不插入任何行。
CREATE TABLE guard (ok INTEGER NOT NULL);

-- ───────────── 同步 ─────────────
CREATE TABLE sync_lease (
  owner_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0,
  holder TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_meta (
  owner_id TEXT PRIMARY KEY,
  published_generation INTEGER NOT NULL DEFAULT 0,
  last_published_at INTEGER,
  last_published_batch_id TEXT,
  last_published_state TEXT,
  last_attempt_at INTEGER,
  last_error_code TEXT,
  checkpoint_newest INTEGER,
  last_full_at INTEGER
);

CREATE TABLE sync_batches (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('initial_full', 'incremental', 'reconciliation_full')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'staging', 'published', 'partial', 'failed')),
  generation INTEGER,
  requested_oldest INTEGER,
  requested_newest INTEGER,
  source_region TEXT,
  coverage TEXT NOT NULL DEFAULT 'unknown' CHECK (coverage IN ('unknown', 'partial', 'verified_window')),
  manifest_json TEXT,
  counts_json TEXT,
  projections_json TEXT,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX sync_batches_owner_created ON sync_batches (owner_id, created_at);
CREATE INDEX sync_batches_state ON sync_batches (state);

CREATE TABLE raw_records (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  profile_ref TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('source_id', 'content_hash')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (owner_id, dataset, profile_ref, source_record_id)
);

-- 每个 raw 版本同时带索引投影；raw_json/raw_chunks 才是原始事实。
CREATE TABLE raw_record_versions (
  id TEXT PRIMARY KEY,
  raw_record_id TEXT NOT NULL REFERENCES raw_records (id),
  owner_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  profile_ref TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  stage_index INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  raw_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  raw_format_version INTEGER NOT NULL,
  sanitizer_version INTEGER NOT NULL,
  raw_json TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  redacted_paths_json TEXT NOT NULL DEFAULT '[]',
  source_data_id TEXT,
  measured_time_raw TEXT,
  measured_at INTEGER,
  local_date TEXT,
  is_deleted INTEGER CHECK (is_deleted IN (0, 1)),
  is_deleted_raw TEXT,
  device_ref TEXT,
  imp_data_id TEXT,
  balance_data_id TEXT,
  gravity_data_id TEXT,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  ext_parse_status TEXT NOT NULL DEFAULT 'missing'
    CHECK (ext_parse_status IN ('missing', 'null', 'empty', 'ok', 'invalid', 'blocked')),
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  formula_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX rrv_record ON raw_record_versions (raw_record_id, published, generation, stage_index);
CREATE INDEX rrv_query ON raw_record_versions (owner_id, dataset, published, measured_at);
CREATE INDEX rrv_relation ON raw_record_versions (owner_id, dataset, profile_ref, source_data_id);
CREATE INDEX rrv_batch ON raw_record_versions (batch_id);

CREATE TABLE raw_chunks (
  version_id TEXT NOT NULL REFERENCES raw_record_versions (id),
  chunk_index INTEGER NOT NULL,
  data BLOB NOT NULL,
  chunk_hash TEXT NOT NULL,
  PRIMARY KEY (version_id, chunk_index)
);

-- 被阻断的内容只记路径、类型和错误码，永不记值。
CREATE TABLE blocked_items (
  id INTEGER PRIMARY KEY,
  batch_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  record_index INTEGER,
  path TEXT NOT NULL,
  value_type TEXT NOT NULL,
  code TEXT NOT NULL
);
CREATE INDEX blocked_items_batch ON blocked_items (batch_id);

CREATE TABLE profiles (
  owner_id TEXT NOT NULL,
  profile_ref TEXT NOT NULL,
  label TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, profile_ref)
);

CREATE TABLE devices (
  owner_id TEXT NOT NULL,
  device_ref TEXT NOT NULL,
  model TEXT,
  firmware TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, device_ref)
);

CREATE TRIGGER raw_records_no_delete BEFORE DELETE ON raw_records
BEGIN SELECT RAISE(ABORT, 'raw_records are append-only'); END;

CREATE TRIGGER rrv_published_no_delete BEFORE DELETE ON raw_record_versions WHEN OLD.published = 1
BEGIN SELECT RAISE(ABORT, 'published raw versions are immutable'); END;

CREATE TRIGGER rrv_published_no_update BEFORE UPDATE ON raw_record_versions WHEN OLD.published = 1
BEGIN SELECT RAISE(ABORT, 'published raw versions are immutable'); END;

-- ───────────── 训练 ─────────────
CREATE TABLE workout_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'finalized')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  started_at TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  started_explicitly INTEGER NOT NULL CHECK (started_explicitly IN (0, 1)),
  ended_at TEXT,
  ended_at_ms INTEGER,
  timezone TEXT NOT NULL,
  facility TEXT,
  title TEXT,
  duration_seconds INTEGER,
  duration_source TEXT NOT NULL DEFAULT 'unknown' CHECK (duration_source IN ('user_reported', 'timestamps', 'unknown')),
  overall_rpe REAL,
  notes TEXT,
  last_activity_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ws_owner_status ON workout_sessions (owner_id, status);
CREATE INDEX ws_owner_started ON workout_sessions (owner_id, started_at_ms, id);

CREATE TABLE workout_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES workout_sessions (id),
  operation TEXT NOT NULL CHECK (operation IN ('start', 'record', 'finalize', 'reopen', 'amend')),
  occurred_at TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  completion_assertion TEXT,
  evidence_origin TEXT NOT NULL,
  parsed_json TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  previous_revision INTEGER NOT NULL,
  resulting_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, idempotency_key)
);
CREATE INDEX we_session ON workout_events (session_id, resulting_revision);

CREATE TABLE workout_entry_versions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES workout_sessions (id),
  event_id TEXT NOT NULL REFERENCES workout_events (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  supersedes_version INTEGER,
  state TEXT NOT NULL CHECK (state IN ('active', 'retracted')),
  sequence INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (entry_id, version)
);
CREATE INDEX wev_session ON workout_entry_versions (session_id, sequence, version);
CREATE INDEX wev_owner_date ON workout_entry_versions (owner_id, occurred_at_ms);

CREATE TABLE write_receipts (
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, idempotency_key)
);

CREATE TRIGGER workout_sessions_no_delete BEFORE DELETE ON workout_sessions
BEGIN SELECT RAISE(ABORT, 'no hard delete in v1'); END;

CREATE TRIGGER workout_events_no_delete BEFORE DELETE ON workout_events
BEGIN SELECT RAISE(ABORT, 'no hard delete in v1'); END;

CREATE TRIGGER workout_events_no_update BEFORE UPDATE ON workout_events
BEGIN SELECT RAISE(ABORT, 'workout events are immutable'); END;

CREATE TRIGGER wev_no_delete BEFORE DELETE ON workout_entry_versions
BEGIN SELECT RAISE(ABORT, 'no hard delete in v1'); END;

CREATE TRIGGER wev_no_update BEFORE UPDATE ON workout_entry_versions
BEGIN SELECT RAISE(ABORT, 'entry versions are immutable'); END;

CREATE TRIGGER write_receipts_no_delete BEFORE DELETE ON write_receipts
BEGIN SELECT RAISE(ABORT, 'receipts live as long as events'); END;

CREATE TRIGGER write_receipts_no_update BEFORE UPDATE ON write_receipts
BEGIN SELECT RAISE(ABORT, 'receipts are immutable'); END;

-- ───────────── 鉴权与限流 ─────────────
-- 一次性授权状态放 D1：DELETE ... RETURNING 保证只能消费一次（KV 最终一致，不能防重放）。
CREATE TABLE auth_pending (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('authorize', 'consent')),
  cookie_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
