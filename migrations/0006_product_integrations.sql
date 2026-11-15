ALTER TABLE api_keys ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
CREATE TABLE api_request_limits (key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE, minute TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(key_id,minute));
CREATE TABLE trace_spans (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT,
 name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
 started_at TEXT NOT NULL, ended_at TEXT, attributes_json TEXT NOT NULL,
 input_json TEXT, output_json TEXT, error_json TEXT, received_at TEXT NOT NULL,
 PRIMARY KEY(project_id,trace_id,span_id)
);
CREATE INDEX idx_trace_project_time ON trace_spans(project_id,started_at DESC);
CREATE TABLE model_routes (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 config_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(project_id,name)
);
CREATE TABLE model_requests (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 route_id TEXT NOT NULL, route_snapshot_json TEXT NOT NULL, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
 step_key TEXT, status TEXT NOT NULL, provider TEXT, model TEXT,
 input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER NOT NULL,
 attempts_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_model_requests_project ON model_requests(project_id,created_at DESC);
CREATE TABLE approval_tasks (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 node_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
 prompt TEXT NOT NULL, payload_json TEXT NOT NULL, decision_by TEXT REFERENCES users(id),
 decision_note TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT,
 UNIQUE(run_id,node_id)
);
CREATE TABLE experiments (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name TEXT NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE experiment_runs (
 experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 PRIMARY KEY(experiment_id,run_id)
);
CREATE TABLE outgoing_webhooks (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 url TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE webhook_deliveries (
 id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES outgoing_webhooks(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT NOT NULL, response_status INTEGER, last_error TEXT, payload_json TEXT NOT NULL,
 UNIQUE(webhook_id,run_id)
);
CREATE TABLE workflow_schedules (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL REFERENCES users(id), workflow_id TEXT NOT NULL REFERENCES workflows(id),
 workflow_version INTEGER NOT NULL, input_json TEXT NOT NULL, interval_minutes INTEGER NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT NOT NULL, last_run_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE scheduled_dispatches (
 schedule_id TEXT NOT NULL REFERENCES workflow_schedules(id) ON DELETE CASCADE,
 scheduled_at TEXT NOT NULL, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
 PRIMARY KEY(schedule_id,scheduled_at)
);
CREATE TRIGGER trace_span_no_cycle BEFORE INSERT ON trace_spans
WHEN NEW.parent_span_id IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'trace span cycle') WHERE EXISTS (
  WITH RECURSIVE ancestors(id) AS (
   SELECT NEW.parent_span_id
   UNION SELECT t.parent_span_id FROM trace_spans t JOIN ancestors a ON t.span_id=a.id
    WHERE t.project_id=NEW.project_id AND t.trace_id=NEW.trace_id AND t.parent_span_id IS NOT NULL
  ) SELECT 1 FROM ancestors WHERE id=NEW.span_id
 );
END;
CREATE TABLE provider_credentials (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, provider TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,provider));
ALTER TABLE model_requests ADD COLUMN estimated_cost_usd REAL;
CREATE TABLE run_model_routes (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,node_id TEXT NOT NULL,route_id TEXT NOT NULL,route_json TEXT NOT NULL,PRIMARY KEY(run_id,node_id));

ALTER TABLE experiment_runs ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX experiment_slot ON experiment_runs(experiment_id,ordinal);
ALTER TABLE workflow_schedules ADD COLUMN last_error TEXT;

ALTER TABLE step_attempts ADD COLUMN input_json TEXT;
ALTER TABLE step_attempts ADD COLUMN output_json TEXT;
