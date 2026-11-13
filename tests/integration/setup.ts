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
    env.DB.prepare("DELETE FROM step_attempts"),
    env.DB.prepare("DELETE FROM execution_events"),
    env.DB.prepare("DELETE FROM workflow_outputs"),
    env.DB.prepare("DELETE FROM execution_steps"),
    env.DB.prepare("DELETE FROM execution_dispatches"),
    env.DB.prepare("DELETE FROM runs"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM quota_counters"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM sandbox_sessions"),
    env.DB.prepare("UPDATE system_flags SET value = 'true' WHERE key = 'sandbox_enabled'"),
    env.DB.prepare("UPDATE system_flags SET value = '' WHERE key = 'sandbox_circuit_open_until'"),
  ]);
});
