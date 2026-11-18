CREATE TABLE repository_indexes (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  commit_sha TEXT,
  manifest_json TEXT NOT NULL,
  files_expected INTEGER NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,snapshot_id)
);
CREATE TABLE repository_index_files (
  project_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY(project_id,snapshot_id,path),
  FOREIGN KEY(project_id,snapshot_id) REFERENCES repository_indexes(project_id,snapshot_id) ON DELETE CASCADE
);
CREATE INDEX repository_indexes_commit ON repository_indexes(project_id,commit_sha,created_at DESC);
