-- Runtime control is independent from retained source discoveries.
ALTER TABLE project_repositories ADD COLUMN scan_progress_json TEXT;
CREATE TABLE managed_repository_checks (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 expires_at TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'QUEUED',
 snapshot_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(project_id,request_key)
);
CREATE INDEX idx_managed_checks_state ON managed_repository_checks(state,created_at);
