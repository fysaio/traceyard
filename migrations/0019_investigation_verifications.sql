CREATE TABLE investigation_verifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  baseline_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  candidate_commit TEXT NOT NULL,
  changed_files_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,request_key)
);
