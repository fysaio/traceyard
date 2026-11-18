CREATE TABLE investigations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key TEXT,
  request_hash TEXT NOT NULL,
  question TEXT NOT NULL,
  target_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ANALYZING','EXECUTING','EVIDENCE_READY','BLOCKED','CANCELLED','FAILED')),
  finding_json TEXT NOT NULL,
  output_chars INTEGER NOT NULL CHECK(output_chars BETWEEN 500 AND 12000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id,request_key)
);
CREATE INDEX investigations_project_history ON investigations(project_id,created_at DESC,id DESC);
CREATE TABLE investigation_evidence (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  basis TEXT NOT NULL CHECK(basis IN ('observed','source')),
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX investigation_evidence_parent ON investigation_evidence(investigation_id,id);
