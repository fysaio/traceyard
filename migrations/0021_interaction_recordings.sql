CREATE TABLE investigation_recordings (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE REFERENCES investigation_attempts(request_id) ON DELETE CASCADE,
  manifest_json TEXT NOT NULL,eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),created_at TEXT NOT NULL
);
CREATE INDEX investigation_recordings_parent ON investigation_recordings(investigation_id,created_at DESC);
