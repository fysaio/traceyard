CREATE TABLE repository_runner_configs (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 config_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE repository_test_cases (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 operation_key TEXT NOT NULL,
 config_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_repository_cases ON repository_test_cases(project_id,operation_key);
CREATE TABLE repository_check_requests (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 snapshot_json TEXT NOT NULL,
 runner_id TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE repository_test_results (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 check_id TEXT NOT NULL,
 case_id TEXT NOT NULL,
 trace_id TEXT NOT NULL,
 result_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(project_id,check_id,case_id)
);
CREATE INDEX idx_repository_result_trace ON repository_test_results(project_id,trace_id);
