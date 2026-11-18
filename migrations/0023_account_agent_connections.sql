-- Preserve existing project grants and their tokens while allowing account connections.
DROP INDEX mcp_grants_project;
ALTER TABLE mcp_grants RENAME TO mcp_grants_previous;
ALTER TABLE oauth_codes RENAME TO oauth_codes_previous;
ALTER TABLE mcp_access_tokens RENAME TO mcp_access_tokens_previous;
ALTER TABLE mcp_refresh_tokens RENAME TO mcp_refresh_tokens_previous;
ALTER TABLE mcp_request_limits RENAME TO mcp_request_limits_previous;
CREATE TABLE mcp_grants (
  id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scopes_json TEXT NOT NULL,resource TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT
);
INSERT INTO mcp_grants SELECT * FROM mcp_grants_previous;
CREATE TABLE oauth_codes (
  token_hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,redirect_uri TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT
);
INSERT INTO oauth_codes SELECT * FROM oauth_codes_previous;
CREATE TABLE mcp_access_tokens (
  token_hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,expires_at TEXT NOT NULL
);
INSERT INTO mcp_access_tokens SELECT * FROM mcp_access_tokens_previous;
CREATE TABLE mcp_refresh_tokens (
  token_hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,expires_at TEXT NOT NULL,consumed_at TEXT
);
INSERT INTO mcp_refresh_tokens SELECT * FROM mcp_refresh_tokens_previous;
CREATE TABLE mcp_request_limits (
  grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,minute TEXT NOT NULL,count INTEGER NOT NULL,
  PRIMARY KEY(grant_id,minute)
);
INSERT INTO mcp_request_limits SELECT * FROM mcp_request_limits_previous;
DROP TABLE mcp_request_limits_previous;
DROP TABLE mcp_refresh_tokens_previous;
DROP TABLE mcp_access_tokens_previous;
DROP TABLE oauth_codes_previous;
DROP TABLE mcp_grants_previous;
CREATE INDEX mcp_grants_project ON mcp_grants(project_id,created_at DESC);
CREATE INDEX mcp_grants_account ON mcp_grants(owner_user_id,created_at DESC) WHERE project_id IS NULL;
CREATE TABLE mcp_project_permissions (
  grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY(grant_id,project_id)
);
