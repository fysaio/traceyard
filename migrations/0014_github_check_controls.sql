-- First-run approval and CI dispatch are durable and independent of source discovery.
ALTER TABLE project_repositories ADD COLUMN ci_setup_json TEXT;
CREATE TABLE github_check_dispatches (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 snapshot_request_id TEXT NOT NULL,
 state TEXT NOT NULL,
 runner_id TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(project_id,request_key)
);
CREATE INDEX idx_github_dispatch_state ON github_check_dispatches(project_id,state,updated_at);

CREATE UNIQUE INDEX idx_github_dispatch_snapshot ON github_check_dispatches(snapshot_request_id);
