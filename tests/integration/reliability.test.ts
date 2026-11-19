import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { randomId } from "../../worker/lib/crypto";
import { dayKey, isoFromNow, nowIso } from "../../worker/lib/time";
import { acquireExecutionLease, countActiveLeases } from "../../worker/persistence/admission";
import { completeStep, getStep, startStepAttempt } from "../../worker/persistence/steps";
import {
  createQuotaReservation,
  getQuotaCount,
  reserveQuota,
} from "../../worker/persistence/quotas";
import { getRunRow } from "../../worker/persistence/runs";
import { runScheduledJobs } from "../../worker/jobs/scheduled";
import { apiFetch, createSession, seedRun } from "./helpers";

const PROJECT_ID = "prj_sandbox";

function concurrencyLimit(): number {
  return Number(env.SANDBOX_GLOBAL_CONCURRENCY_LIMIT);
}

async function firstStep(runId: string): Promise<{ id: string; stepKey: string }> {
  const row = await env.DB.prepare(
    `SELECT id, step_key FROM execution_steps
      WHERE run_id = ? ORDER BY ordinal ASC LIMIT 1`,
  )
    .bind(runId)
    .first<{ id: string; step_key: string }>();
  if (row === null) throw new Error("Seed run has no steps.");
  return { id: row.id, stepKey: row.step_key };
}

async function attemptStatus(
  runId: string,
  stepKey: string,
  attempt: number,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT a.status FROM step_attempts a
       JOIN execution_steps s ON s.id = a.step_id
      WHERE a.run_id = ? AND s.step_key = ? AND a.attempt_number = ?`,
  )
    .bind(runId, stepKey, attempt)
    .first<{ status: string }>();
  return row?.status ?? null;
}

describe("quota admission", () => {
  it("releases an interrupted reservation whose run never materialised", async () => {
    const missingRunId = randomId("run");
    await createQuotaReservation(env.DB, missingRunId);
    const reserved = await reserveQuota(env.DB, missingRunId, {
      bucketKey: `global:day:${dayKey()}`,
      limit: 100,
      windowStart: `${dayKey()}T00:00:00.000Z`,
      expiresAt: isoFromNow(24 * 60 * 60 * 1000),
    });
    expect(reserved.allowed).toBe(true);
    expect(await getQuotaCount(env.DB, `global:day:${dayKey()}`)).toBe(1);

    await env.DB.prepare(`UPDATE quota_reservations SET created_at = ? WHERE run_id = ?`)
      .bind(isoFromNow(-10 * 60 * 1000), missingRunId)
      .run();

    const summary = await runScheduledJobs(env);
    expect(summary.releasedQuotaReservations).toBe(1);
    expect(await getQuotaCount(env.DB, `global:day:${dayKey()}`)).toBe(0);
    const reservation = await env.DB.prepare(
      `SELECT status FROM quota_reservations WHERE run_id = ?`,
    )
      .bind(missingRunId)
      .first<{ status: string }>();
    expect(reservation?.status).toBe("RELEASED");
  });

  it("commits an interrupted reservation whose run exists", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    await createQuotaReservation(env.DB, runId);
    const reserved = await reserveQuota(env.DB, runId, {
      bucketKey: `global:day:${dayKey()}`,
      limit: 100,
      windowStart: `${dayKey()}T00:00:00.000Z`,
      expiresAt: isoFromNow(24 * 60 * 60 * 1000),
    });
    expect(reserved.allowed).toBe(true);

    await env.DB.prepare(`UPDATE quota_reservations SET created_at = ? WHERE run_id = ?`)
      .bind(isoFromNow(-10 * 60 * 1000), runId)
      .run();

    const summary = await runScheduledJobs(env);
    expect(summary.committedQuotaReservations).toBe(1);
    expect(await getQuotaCount(env.DB, `global:day:${dayKey()}`)).toBe(1);
    const reservation = await env.DB.prepare(
      `SELECT status FROM quota_reservations WHERE run_id = ?`,
    )
      .bind(runId)
      .first<{ status: string }>();
    expect(reservation?.status).toBe("COMMITTED");
  });
});

describe("step claim fencing", () => {
  it("never lets two attempts own the same step generation", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    const step = await firstStep(runId);

    const claimed = await startStepAttempt(env.DB, {
      runId,
      stepId: step.id,
      stepKey: step.stepKey,
      attemptNumber: 1,
      inputJson: null,
    });
    expect(claimed.state).toBe("started");

    const duplicate = await startStepAttempt(env.DB, {
      runId,
      stepId: step.id,
      stepKey: step.stepKey,
      attemptNumber: 1,
      inputJson: null,
    });
    expect(duplicate.state).toBe("busy");

    // A completion from a newer generation cannot complete the older claim.
    const premature = await completeStep(env.DB, {
      runId,
      stepId: step.id,
      stepKey: step.stepKey,
      attemptNumber: 2,
      outputJson: JSON.stringify({ value: "premature" }),
      eventMessage: "premature",
    });
    expect(premature.changed).toBe(false);

    const takeover = await startStepAttempt(env.DB, {
      runId,
      stepId: step.id,
      stepKey: step.stepKey,
      attemptNumber: 2,
      inputJson: null,
    });
    expect(takeover.state).toBe("started");
    // The superseded attempt is abandoned, so the inspector never shows two
    // running attempts for one step.
    expect(await attemptStatus(runId, step.stepKey, 1)).toBe("ABANDONED");
    expect(await attemptStatus(runId, step.stepKey, 2)).toBe("RUNNING");

    const completed = await completeStep(env.DB, {
      runId,
      stepId: step.id,
      stepKey: step.stepKey,
      attemptNumber: 2,
      outputJson: JSON.stringify({ value: "done" }),
      eventMessage: "done",
    });
    expect(completed.changed).toBe(true);
    expect(await attemptStatus(runId, step.stepKey, 2)).toBe("SUCCEEDED");
  });

  it("keeps attempt-scoped completion idempotent", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    const step = await firstStep(runId);
    await startStepAttempt(env.DB, {
      runId,
      stepId: step.id,
      stepKey: step.stepKey,
      attemptNumber: 1,
      inputJson: null,
    });

    const first = await completeStep(env.DB, {
      runId,
      stepId: step.id,
      stepKey: step.stepKey,
      attemptNumber: 1,
      outputJson: JSON.stringify({ value: "done" }),
      eventMessage: "done",
    });
    const second = await completeStep(env.DB, {
      runId,
      stepId: step.id,
      stepKey: step.stepKey,
      attemptNumber: 1,
      outputJson: JSON.stringify({ value: "done" }),
      eventMessage: "done",
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(await attemptStatus(runId, step.stepKey, 1)).toBe("SUCCEEDED");
  });
});

describe("cancellation invariants", () => {
  it("repairs a terminal run that still owns a RUNNING step", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    const step = await firstStep(runId);
    await startStepAttempt(env.DB, {
      runId,
      stepId: step.id,
      stepKey: step.stepKey,
      attemptNumber: 1,
      inputJson: null,
    });
    const startedAt = isoFromNow(-60_000);
    await env.DB.prepare(
      `UPDATE runs SET status = 'CANCELLED', started_at = ?, completed_at = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(startedAt, startedAt, startedAt, runId)
      .run();

    await runScheduledJobs(env);

    expect((await getStep(env.DB, runId, step.stepKey))?.status).toBe("CANCELLED");
    expect(await attemptStatus(runId, step.stepKey, 1)).toBe("ABANDONED");
  });
});

describe("stale RUNNING reconciliation", () => {
  const STALE_OFFSET = -11 * 60 * 1000;

  it("closes a stale RUNNING run as an explicit uncertain failure", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    await acquireExecutionLease(env.DB, PROJECT_ID, runId, concurrencyLimit());
    const step = await firstStep(runId);
    await startStepAttempt(env.DB, {
      runId,
      stepId: step.id,
      stepKey: step.stepKey,
      attemptNumber: 1,
      inputJson: null,
    });

    const stale = isoFromNow(STALE_OFFSET);
    await env.DB.prepare(
      `UPDATE runs SET status = 'RUNNING', started_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(stale, stale, runId)
      .run();

    const summary = await runScheduledJobs(env);
    expect(summary.reconciledStaleRunning).toBe(1);

    const run = await getRunRow(env.DB, runId);
    expect(run?.status).toBe("FAILED");
    expect(run?.error_class).toBe("EXECUTION_INFRASTRUCTURE");
    expect(run?.error_json).toContain("EXECUTION_OUTCOME_UNKNOWN");

    expect((await getStep(env.DB, runId, step.stepKey))?.status).toBe("FAILED");
    expect(await attemptStatus(runId, step.stepKey, 1)).toBe("ABANDONED");
    expect(await countActiveLeases(env.DB, PROJECT_ID)).toBe(0);

    const event = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM execution_events
        WHERE run_id = ? AND type = 'run.reconciled.uncertain'`,
    )
      .bind(runId)
      .first<{ count: number }>();
    expect(Number(event?.count)).toBe(1);

    // Re-running the reconciler is idempotent.
    const second = await runScheduledJobs(env);
    expect(second.reconciledStaleRunning).toBe(0);
  });

  it("does not touch a RUNNING run that is still making progress", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    await env.DB.prepare(
      `UPDATE runs SET status = 'RUNNING', started_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso(), nowIso(), runId)
      .run();

    const summary = await runScheduledJobs(env);
    expect(summary.reconciledStaleRunning).toBe(0);
    expect((await getRunRow(env.DB, runId))?.status).toBe("RUNNING");
  });

  it("does not overwrite a terminal transition that already happened", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    const stale = isoFromNow(STALE_OFFSET);
    await env.DB.prepare(
      `UPDATE runs SET status = 'SUCCEEDED', completed_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(stale, stale, runId)
      .run();

    const summary = await runScheduledJobs(env);
    expect(summary.reconciledStaleRunning).toBe(0);
    expect((await getRunRow(env.DB, runId))?.status).toBe("SUCCEEDED");
  });
});

describe("session cleanup", () => {
  async function insertSession(idHash: string, lastSeenAt: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO sandbox_sessions (id_hash, ip_hash, user_agent_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(idHash, "ip-test", "ua-test", lastSeenAt, lastSeenAt)
      .run();
  }

  it("deletes obsolete sessions but retains one that still owns history", async () => {
    const owner = await createSession();
    const retainedSince = isoFromNow(-40 * 24 * 60 * 60 * 1000);
    await env.DB.prepare(`UPDATE sandbox_sessions SET last_seen_at = ? WHERE id_hash = ?`)
      .bind(retainedSince, owner.idHash)
      .run();
    await seedRun({ session: owner });

    const idleHash = `idle_${crypto.randomUUID()}`;
    await insertSession(idleHash, retainedSince);

    const ancientHash = `ancient_${crypto.randomUUID()}`;
    await insertSession(ancientHash, isoFromNow(-200 * 24 * 60 * 60 * 1000));

    const recentHash = `recent_${crypto.randomUUID()}`;
    await insertSession(recentHash, isoFromNow(-24 * 60 * 60 * 1000));

    const summary = await runScheduledJobs(env);
    expect(summary.deletedSessions).toBe(2);

    const remaining = await env.DB.prepare(`SELECT id_hash FROM sandbox_sessions`).all<{
      id_hash: string;
    }>();
    const hashes = remaining.results.map((row) => row.id_hash);
    expect(hashes).toContain(owner.idHash);
    expect(hashes).toContain(recentHash);
    expect(hashes).not.toContain(idleHash);
    expect(hashes).not.toContain(ancientHash);
  });
});

describe("security headers", () => {
  it("serves a compatible CSP and Permissions-Policy", async () => {
    const response = await apiFetch("/api/health");
    expect(response.status).toBe(200);

    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/u);
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");

    const permissions = response.headers.get("permissions-policy") ?? "";
    expect(permissions).toContain("camera=()");
    expect(permissions).toContain("microphone=()");
    expect(permissions).toContain("geolocation=()");
    expect(permissions).toContain("clipboard-write=(self)");

    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("applies the same headers to error responses", async () => {
    const session = await createSession();
    const response = await apiFetch("/api/runs/run_missing", {}, session);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });
});
