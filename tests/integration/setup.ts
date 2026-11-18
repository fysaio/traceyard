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
    env.DB.prepare("DELETE FROM http_requests"),
    env.DB.prepare("DELETE FROM http_connections"),
    env.DB.prepare("DELETE FROM workflow_schedules"),
    env.DB.prepare("DELETE FROM outgoing_webhooks"),
    env.DB.prepare("DELETE FROM experiments"),
    env.DB.prepare("DELETE FROM approval_tasks"),
    env.DB.prepare("DELETE FROM model_requests"),
    env.DB.prepare("DELETE FROM model_routes"),
    env.DB.prepare("DELETE FROM trace_spans"),
    env.DB.prepare("DELETE FROM saved_workflows"),
    env.DB.prepare("DELETE FROM api_keys"),
    env.DB.prepare("DELETE FROM organization_memberships"),
    env.DB.prepare("DELETE FROM organizations"),
    env.DB.prepare("DELETE FROM user_sessions"),
    env.DB.prepare("DELETE FROM github_oauth_states"),
    env.DB.prepare("DELETE FROM identities"),
    env.DB.prepare("DELETE FROM quota_reservation_buckets"),
    env.DB.prepare("DELETE FROM quota_reservations"),
    env.DB.prepare("DELETE FROM execution_leases"),
    env.DB.prepare("DELETE FROM step_attempts"),
    env.DB.prepare("DELETE FROM execution_events"),
    env.DB.prepare("DELETE FROM workflow_outputs"),
    env.DB.prepare("DELETE FROM execution_steps"),
    env.DB.prepare("DELETE FROM execution_dispatches"),
    env.DB.prepare("DELETE FROM runs"),
    env.DB.prepare("DELETE FROM projects WHERE owner_user_id IS NOT NULL"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM quota_counters"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM sandbox_sessions"),
    env.DB.prepare(
      "INSERT INTO system_flags(key,value,updated_at) VALUES('sandbox_enabled','true',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ),
    env.DB.prepare(
      "INSERT INTO system_flags(key,value,updated_at) VALUES('sandbox_circuit_open_until','',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ),
  ]);
});
