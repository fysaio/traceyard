-- Persist workflow presentation metadata without embedding credentials in exports.
ALTER TABLE workflows ADD COLUMN icon TEXT NOT NULL DEFAULT 'diagram-project';

CREATE TABLE http_connections (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,name TEXT NOT NULL,url TEXT NOT NULL,method TEXT NOT NULL,secret_ciphertext TEXT,created_at TEXT NOT NULL,UNIQUE(project_id,name));
CREATE TABLE run_http_connections (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,node_id TEXT NOT NULL,connection_json TEXT NOT NULL,PRIMARY KEY(run_id,node_id));
CREATE TABLE http_requests (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,node_id TEXT NOT NULL,connection_id TEXT NOT NULL,status TEXT NOT NULL,http_status INTEGER,duration_ms INTEGER NOT NULL,created_at TEXT NOT NULL,error TEXT);
CREATE INDEX http_requests_run ON http_requests(run_id,node_id);
