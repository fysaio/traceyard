CREATE TABLE investigation_attempts (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','BLOCKED','CANCELLED')),
  check_id TEXT,
  report_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX investigation_attempts_parent ON investigation_attempts(investigation_id,created_at DESC);
