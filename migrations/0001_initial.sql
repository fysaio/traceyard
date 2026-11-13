-- Traceyard initial schema.
--
-- Design notes:
-- * D1 is SQLite. All timestamps are ISO-8601 UTC strings with millisecond
--   precision, which sort lexicographically and survive export unchanged.
-- * Run and step transitions are guarded by conditional UPDATE statements in
--   the repository layer; the CHECK constraints here are a second line of
--   defence against corrupt state.
-- * Event `seq` is an AUTOINCREMENT key and doubles as the pagination cursor.
-- * `execution_dispatches` is a durable outbox for queue publication. A run and
--   its dispatch are written in one D1 batch, but queue publication is not in
--   that transaction and is reconciled by the scheduled job.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sandbox', 'standard')),
  created_at TEXT NOT NULL
);

CREATE TABLE sandbox_sessions (
  id_hash TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  user_agent_hash TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX idx_sandbox_sessions_ip ON sandbox_sessions (ip_hash, last_seen_at);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, slug)
);

CREATE TABLE workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  input_schema_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, version)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  workflow_id TEXT NOT NULL REFERENCES workflows (id),
  workflow_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLING', 'CANCELLED')
  ),
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('sandbox', 'api', 'retry')),
  scenario TEXT NOT NULL DEFAULT 'success' CHECK (
    scenario IN ('success', 'retryable_failure', 'terminal_failure')
  ),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  owner_session_hash TEXT REFERENCES sandbox_sessions (id_hash) ON DELETE SET NULL,
  owner_ip_hash TEXT,
  parent_run_id TEXT REFERENCES runs (id) ON DELETE SET NULL,
  retry_of_run_id TEXT UNIQUE REFERENCES runs (id) ON DELETE SET NULL,
  retry_run_id TEXT REFERENCES runs (id) ON DELETE SET NULL,
  idempotency_key TEXT,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_json TEXT,
  error_class TEXT,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  cancel_requested_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_runs_owner_created ON runs (owner_session_hash, created_at DESC, id DESC);
CREATE INDEX idx_runs_project_created ON runs (project_id, created_at DESC, id DESC);
CREATE INDEX idx_runs_status_created ON runs (status, created_at DESC);
CREATE INDEX idx_runs_workflow_created ON runs (workflow_id, created_at DESC);
CREATE INDEX idx_runs_parent ON runs (parent_run_id);
CREATE INDEX idx_runs_retry_of ON runs (retry_of_run_id);
CREATE INDEX idx_runs_active ON runs (status, created_at)
  WHERE status IN ('QUEUED', 'RUNNING', 'CANCELLING');
CREATE INDEX idx_runs_expiry ON runs (expires_at);
CREATE UNIQUE INDEX idx_runs_idempotency
  ON runs (owner_session_hash, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE execution_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  name TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')
  ),
  max_attempts INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  input_json TEXT,
  output_json TEXT,
  error_json TEXT,
  error_class TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, step_key)
);

CREATE INDEX idx_steps_run_ordinal ON execution_steps (run_id, ordinal);
CREATE INDEX idx_steps_status ON execution_steps (status);

CREATE TABLE step_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES execution_steps (id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED')),
  error_json TEXT,
  error_class TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (step_id, attempt_number)
);

CREATE INDEX idx_attempts_run ON step_attempts (run_id, started_at);
CREATE INDEX idx_attempts_step ON step_attempts (step_id, attempt_number);

CREATE TABLE execution_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  step_key TEXT,
  attempt_number INTEGER,
  data_json TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_events_run_seq ON execution_events (run_id, seq);

CREATE TABLE execution_dispatches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN ('PENDING', 'PUBLISHED', 'CLAIMED', 'FAILED', 'CANCELLED')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  claimed_at TEXT
);

CREATE INDEX idx_dispatches_reconcile ON execution_dispatches (status, available_at);

CREATE TABLE workflow_outputs (
  run_id TEXT PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  output_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX idx_idempotency_expiry ON idempotency_records (expires_at);

CREATE TABLE quota_counters (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  limit_value INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_quota_expiry ON quota_counters (expires_at);

CREATE TABLE system_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('anonymous', 'system', 'api_key', 'user')),
  actor_id_hash TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_project_created ON audit_events (project_id, created_at DESC);
CREATE INDEX idx_audit_action_created ON audit_events (action, created_at DESC);
