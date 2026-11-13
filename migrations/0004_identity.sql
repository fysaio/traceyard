-- Durable developer identities and project-scoped account data.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github')),
  provider_subject TEXT NOT NULL,
  provider_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject)
);

CREATE INDEX idx_identities_user ON identities (user_id);

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL UNIQUE,
  user_agent_hash TEXT,
  ip_hash TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_user_sessions_user ON user_sessions (user_id, created_at DESC);
CREATE INDEX idx_user_sessions_expiry ON user_sessions (expires_at);

CREATE TABLE github_oauth_states (
  state_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX idx_github_oauth_states_expiry ON github_oauth_states (expires_at);

ALTER TABLE projects
  ADD COLUMN owner_user_id TEXT REFERENCES users (id);

CREATE INDEX idx_projects_owner ON projects (owner_user_id, created_at DESC);

ALTER TABLE runs
  ADD COLUMN owner_user_id TEXT REFERENCES users (id);

CREATE INDEX idx_runs_owner_user_created
  ON runs (owner_user_id, created_at DESC, id DESC);

CREATE TABLE saved_workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, slug)
);

CREATE INDEX idx_saved_workflows_owner ON saved_workflows (owner_user_id, project_id);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE organization_memberships (
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX idx_memberships_user ON organization_memberships (user_id, organization_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX idx_api_keys_project ON api_keys (project_id, revoked_at);
