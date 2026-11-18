CREATE INDEX investigations_retention ON investigations(updated_at,status);
CREATE INDEX repository_indexes_retention ON repository_indexes(created_at);
CREATE INDEX oauth_consents_expiration ON oauth_consents(expires_at);
CREATE INDEX oauth_codes_expiration ON oauth_codes(expires_at);
CREATE INDEX mcp_access_expiration ON mcp_access_tokens(expires_at);
CREATE INDEX mcp_refresh_expiration ON mcp_refresh_tokens(expires_at);
CREATE INDEX mcp_limits_expiration ON mcp_request_limits(minute);
