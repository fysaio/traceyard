CREATE TABLE github_installations (
 id INTEGER PRIMARY KEY,
 account_id TEXT NOT NULL,
 account_login TEXT NOT NULL,
 suspended INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);
CREATE TABLE project_repositories (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 repository_id INTEGER UNIQUE,
 installation_id INTEGER REFERENCES github_installations(id),
 full_name TEXT NOT NULL,
 default_branch TEXT,
 commit_sha TEXT,
 status TEXT NOT NULL DEFAULT 'DISCOVERING',
 scan_json TEXT,
 last_error TEXT,
 setup_pr_url TEXT,
 runner_enabled INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);
CREATE TABLE repository_jobs (
 id TEXT NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 commit_sha TEXT,
 source TEXT NOT NULL,
 phase TEXT NOT NULL,
 status TEXT NOT NULL,
 events_json TEXT NOT NULL DEFAULT '[]',
 github_url TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(project_id,id)
);
CREATE INDEX idx_repository_jobs_project ON repository_jobs(project_id,updated_at DESC);

CREATE TABLE github_webhook_deliveries (digest TEXT PRIMARY KEY,received_at TEXT NOT NULL);
