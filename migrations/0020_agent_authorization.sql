CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,name TEXT NOT NULL,redirects_json TEXT NOT NULL,ip_hash TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE TABLE oauth_consents (
  token_hash TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_json TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT
);
CREATE TABLE mcp_grants (
  id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scopes_json TEXT NOT NULL,resource TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT
);
CREATE TABLE oauth_codes (
  token_hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,redirect_uri TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT
);
CREATE TABLE mcp_access_tokens (
  token_hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,expires_at TEXT NOT NULL
);
CREATE TABLE mcp_refresh_tokens (
  token_hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,expires_at TEXT NOT NULL,consumed_at TEXT
);
CREATE TABLE mcp_request_limits (
  grant_id TEXT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,minute TEXT NOT NULL,count INTEGER NOT NULL,
  PRIMARY KEY(grant_id,minute)
);
CREATE INDEX mcp_grants_project ON mcp_grants(project_id,created_at DESC);
ALTER TABLE github_oauth_states ADD COLUMN return_to TEXT;
