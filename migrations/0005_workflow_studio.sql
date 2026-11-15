ALTER TABLE workflow_versions ADD COLUMN graph_json TEXT;
CREATE TABLE workflow_drafts (
 workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
 graph_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL
);
ALTER TABLE workflows ADD COLUMN archived_at TEXT;
