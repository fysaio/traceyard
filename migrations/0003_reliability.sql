-- Execution admission leases.
--
-- A lease is the authoritative record of one active execution slot. It is
-- acquired by a single conditional INSERT before a run bundle is written, so
-- two concurrent launchers cannot both observe a free slot. Leases are
-- released when the run becomes terminal (or by the bounded reconciler if the
-- run disappeared).
CREATE TABLE execution_leases (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);

CREATE INDEX idx_execution_leases_project ON execution_leases (project_id);

-- Backfill leases for runs that were active when this migration is applied.
INSERT INTO execution_leases (run_id, project_id, acquired_at)
SELECT id, project_id, COALESCE(started_at, created_at)
  FROM runs
 WHERE status IN ('QUEUED', 'RUNNING', 'CANCELLING');

-- Quota reservation ledger.
--
-- Bucket counters are incremented sequentially for SQLite/D1 compatibility.
-- Counter increments and their child ledger rows are committed in the same
-- D1 batch, so reconciliation can release exactly the buckets consumed.
CREATE TABLE quota_reservations (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMMITTED', 'RELEASED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_quota_reservations_status ON quota_reservations (status, created_at);

CREATE TABLE quota_reservation_buckets (
  run_id TEXT NOT NULL REFERENCES quota_reservations (run_id) ON DELETE CASCADE,
  bucket_key TEXT NOT NULL,
  PRIMARY KEY (run_id, bucket_key)
);

CREATE INDEX idx_quota_reservation_buckets_bucket ON quota_reservation_buckets (bucket_key);

-- Session-scoped analytics predicates include project_id and owner_session_hash;
-- the previous project-only index forced a scan of every session's runs.
CREATE INDEX idx_runs_project_owner_created
  ON runs (project_id, owner_session_hash, created_at DESC, id DESC);

-- Stale-RUNNING reconciliation scans by status and progress time.
CREATE INDEX idx_runs_status_updated ON runs (status, updated_at);

-- Session expiry cleanup scans by last activity.
CREATE INDEX idx_sandbox_sessions_seen ON sandbox_sessions (last_seen_at);
