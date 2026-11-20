import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach } from "vitest";

/**
 * Each integration test file receives an isolated D1 database. Applying the
 * checked-in migrations here guarantees the tests exercise the exact
 * production schema, including CHECK constraints and unique indexes.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/**
 * Reset mutable state between tests while preserving the seeded catalog. This
 * keeps assertions deterministic even when a runner reuses storage across
 * tests within a file.
 */
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM investigation_recordings"),
    env.DB.prepare("DELETE FROM mcp_request_limits"),
    env.DB.prepare("DELETE FROM mcp_access_tokens"),
    env.DB.prepare("DELETE FROM mcp_refresh_tokens"),
    env.DB.prepare("DELETE FROM oauth_codes"),
    env.DB.prepare("DELETE FROM mcp_grants"),
    env.DB.prepare("DELETE FROM oauth_consents"),
    env.DB.prepare("DELETE FROM oauth_clients"),
    env.DB.prepare("DELETE FROM investigation_verifications"),
    env.DB.prepare("DELETE FROM investigation_attempts"),
    env.DB.prepare("DELETE FROM repository_index_files"),
    env.DB.prepare("DELETE FROM repository_indexes"),
    env.DB.prepare("DELETE FROM investigation_evidence"),
    env.DB.prepare("DELETE FROM investigations"),
    env.DB.prepare("DELETE FROM managed_repository_checks"),
    env.DB.prepare("DELETE FROM repository_test_results"),
    env.DB.prepare("DELETE FROM github_check_dispatches"),
    env.DB.prepare("DELETE FROM repository_check_requests"),
    env.DB.prepare("DELETE FROM repository_test_cases"),
    env.DB.prepare("DELETE FROM repository_runner_configs"),
    env.DB.prepare("DELETE FROM repository_jobs"),
    env.DB.prepare("DELETE FROM project_repositories"),
    env.DB.prepare("DELETE FROM github_installations"),
    env.DB.prepare("DELETE FROM github_webhook_deliveries"),
    env.DB.prepare("DELETE FROM trace_spans"),
    env.DB.prepare("DELETE FROM api_keys"),
    env.DB.prepare("DELETE FROM user_sessions"),
    env.DB.prepare("DELETE FROM github_oauth_states"),
    env.DB.prepare("DELETE FROM identities"),
    env.DB.prepare("DELETE FROM projects WHERE owner_user_id IS NOT NULL"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM sandbox_sessions"),
  ]);
});
