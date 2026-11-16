import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type {
  CancelRunResult,
  RetryRunResult,
  RunDetail,
  WorkflowSummary,
} from "../../shared/contracts/api";
import { randomId } from "../../worker/lib/crypto";
import { dayKey, hourKey, isoFromNow, nowIso } from "../../worker/lib/time";
import { acquireExecutionLease, countActiveLeases } from "../../worker/persistence/admission";
import { completeStep, getStep, startStepAttempt } from "../../worker/persistence/steps";
import {
  createQuotaReservation,
  getQuotaCount,
  reserveQuota,
} from "../../worker/persistence/quotas";
import { getRunRow } from "../../worker/persistence/runs";
import { finalizeRunCancelled } from "../../worker/execution/finalize";
import { runScheduledJobs } from "../../worker/jobs/scheduled";
import {
  apiFetch,
  createSession,
  getRunDetail,
  launchBody,
  launchRun,
  postJson,
  readFailure,
  readSuccess,
  seedRun,
  VALID_INPUT,
} from "./helpers";

const PROJECT_ID = "prj_sandbox";

function concurrencyLimit(): number {
  return Number(env.SANDBOX_GLOBAL_CONCURRENCY_LIMIT);
}

/**
 * Fills concurrency capacity with leases. The referenced runs do not need to
 * exist: admission counts lease rows, exactly as it does for active runs.
 */
async function fillCapacity(count: number): Promise<string[]> {
  const runIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const runId = randomId("run");
    const lease = await acquireExecutionLease(env.DB, PROJECT_ID, runId, concurrencyLimit());
    expect(lease.acquired).toBe(true);
    runIds.push(runId);
  }
  return runIds;
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

describe("idempotent launch", () => {
  it("converges concurrent identical keys onto one execution", async () => {
    const session = await createSession();
    const key = `idem_${crypto.randomUUID()}`;

    const [first, second] = await Promise.all([
      postJson("/api/runs", launchBody(), session, { "idempotency-key": key }),
      postJson("/api/runs", launchBody(), session, { "idempotency-key": key }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 202]);
    const bodies = await Promise.all([
      readSuccess<{ run: RunDetail }>(first),
      readSuccess<{ run: RunDetail }>(second),
    ]);
    expect(new Set(bodies.map((body) => body.run.id)).size).toBe(1);

    const runs = await env.DB.prepare(`SELECT COUNT(*) AS count FROM runs`).first<{
      count: number;
    }>();
    expect(Number(runs?.count)).toBe(1);

    // A replayed launch consumes no extra concurrency slot or quota unit.
    expect(await countActiveLeases(env.DB, PROJECT_ID)).toBe(1);
    expect(await getQuotaCount(env.DB, `session:${session.idHash}:hour:${hourKey()}`)).toBe(1);
    expect(await getQuotaCount(env.DB, `global:day:${dayKey()}`)).toBe(1);
  });

  it("returns the existing execution for an equivalent repeat", async () => {
    const session = await createSession();
    const key = `idem_${crypto.randomUUID()}`;

    const created = await launchRun(session, {}, key);
    expect(created.response.status).toBe(202);

    const replayed = await launchRun(session, {}, key);
    expect(replayed.response.status).toBe(200);
    expect(replayed.result?.run.id).toBe(created.result?.run.id);
    expect(replayed.result?.replayed).toBe(true);

    expect(await countActiveLeases(env.DB, PROJECT_ID)).toBe(1);
    expect(await getQuotaCount(env.DB, `session:${session.idHash}:hour:${hourKey()}`)).toBe(1);
  });

  it("rejects a reused key with a different payload as a clear conflict", async () => {
    const session = await createSession();
    const key = `idem_${crypto.randomUUID()}`;

    const created = await launchRun(session, {}, key);
    expect(created.response.status).toBe(202);

    const response = await postJson(
      "/api/runs",
      launchBody({ input: { ...VALID_INPUT, title: "A different document title" } }),
      session,
      { "idempotency-key": key },
    );

    expect(response.status).toBe(422);
    const error = await readFailure(response);
    expect(error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(error.message).toContain("different request body");
  });
});

describe("concurrency admission", () => {
  it("rejects a launch at the ceiling with structured details and no side effects", async () => {
    const session = await createSession();
    const limit = concurrencyLimit();
    await fillCapacity(limit);

    const response = await postJson("/api/runs", launchBody(), session, {
      "idempotency-key": `idem_${crypto.randomUUID()}`,
    });

    expect(response.status).toBe(429);
    const error = await readFailure(response);
    expect(error.code).toBe("SANDBOX_CONCURRENCY_LIMIT");
    expect(error.details).toMatchObject({ scope: "concurrency", limit, active: limit });
    // Concurrency has no deterministic reset time, so no Retry-After is invented.
    expect(response.headers.get("retry-after")).toBeNull();

    const runs = await env.DB.prepare(`SELECT COUNT(*) AS count FROM runs`).first<{
      count: number;
    }>();
    expect(Number(runs?.count)).toBe(0);
    expect(await countActiveLeases(env.DB, PROJECT_ID)).toBe(limit);

    const audit = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'sandbox.concurrency_rejected'`,
    ).first<{ count: number }>();
    expect(Number(audit?.count)).toBe(1);
  });

  it("admits the last slot atomically and releases it when the run is cancelled", async () => {
    const session = await createSession();
    const limit = concurrencyLimit();
    await fillCapacity(limit - 1);

    const accepted = await launchRun(session, {}, `idem_${crypto.randomUUID()}`);
    expect(accepted.response.status).toBe(202);
    expect(await countActiveLeases(env.DB, PROJECT_ID)).toBe(limit);

    const rejected = await launchRun(
      session,
      { input: { ...VALID_INPUT, title: "Another execution" } },
      `idem_${crypto.randomUUID()}`,
    );
    expect(rejected.response.status).toBe(429);

    const cancel = await apiFetch(
      `/api/runs/${accepted.result!.run.id}/cancel`,
      { method: "POST" },
      session,
    );
    expect(cancel.status).toBe(200);
    const result = await readSuccess<CancelRunResult>(cancel);
    expect(result.status).toBe("CANCELLED");
    expect(await countActiveLeases(env.DB, PROJECT_ID)).toBe(limit - 1);

    const run = await getRunRow(env.DB, accepted.result!.run.id);
    expect(run?.status).toBe("CANCELLED");
  });

  it("applies the same ceiling to retries and releases the slot on success", async () => {
    const session = await createSession();
    const failure = await seedRun({ session, status: "FAILED" });
    const limit = concurrencyLimit();
    const leases = await fillCapacity(limit);

    const rejected = await apiFetch(
      `/api/runs/${failure.runId}/retry`,
      { method: "POST" },
      session,
    );
    expect(rejected.status).toBe(429);
    expect((await readFailure(rejected)).code).toBe("SANDBOX_CONCURRENCY_LIMIT");

    const stillOneRun = await env.DB.prepare(`SELECT COUNT(*) AS count FROM runs`).first<{
      count: number;
    }>();
    expect(Number(stillOneRun?.count)).toBe(1);

    await env.DB.prepare(`DELETE FROM execution_leases WHERE run_id = ?`).bind(leases[0]).run();

    const accepted = await apiFetch(
      `/api/runs/${failure.runId}/retry`,
      { method: "POST" },
      session,
    );
    expect(accepted.status).toBe(202);
    const retried = await readSuccess<RetryRunResult>(accepted);
    expect(retried.run.id).not.toBe(failure.runId);
    expect(retried.run.retryOfRunId).toBe(failure.runId);
    expect(await countActiveLeases(env.DB, PROJECT_ID)).toBe(limit);
  });
});

describe("quota admission", () => {
  async function setSessionHourlyUsage(sessionHash: string, count: number, limit: number) {
    const hour = hourKey();
    await env.DB.prepare(
      `INSERT INTO quota_counters (bucket_key, count, limit_value, window_start, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (bucket_key) DO UPDATE SET count = excluded.count, limit_value = excluded.limit_value`,
    )
      .bind(
        `session:${sessionHash}:hour:${hour}`,
        count,
        limit,
        `${hour}:00:00.000Z`,
        isoFromNow(60 * 60 * 1000),
        nowIso(),
      )
      .run();
  }

  it("returns a structured session quota response and rolls back partial reservations", async () => {
    const session = await createSession();
    const limit = Number(env.SANDBOX_SESSION_HOURLY_LIMIT);
    await setSessionHourlyUsage(session.idHash, limit, limit);

    const response = await postJson("/api/runs", launchBody(), session, {
      "idempotency-key": `idem_${crypto.randomUUID()}`,
    });

    expect(response.status).toBe(429);
    const error = await readFailure(response);
    expect(error.code).toBe("SESSION_HOURLY_QUOTA");
    expect(error.details).toMatchObject({ scope: "session", limit, used: limit });
    const retryAfter = Number(response.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60 * 60);

    // Global and session-day counters were incremented before the hourly
    // rejection; the reservation release must roll all of them back.
    expect(await getQuotaCount(env.DB, `global:day:${dayKey()}`)).toBe(0);
    expect(await getQuotaCount(env.DB, `session:${session.idHash}:day:${dayKey()}`)).toBe(0);
    expect(await countActiveLeases(env.DB, PROJECT_ID)).toBe(0);

    const runs = await env.DB.prepare(`SELECT COUNT(*) AS count FROM runs`).first<{
      count: number;
    }>();
    expect(Number(runs?.count)).toBe(0);

    const reservations = await env.DB.prepare(`SELECT status FROM quota_reservations`).all<{
      status: string;
    }>();
    expect(reservations.results).toHaveLength(1);
    expect(reservations.results[0]?.status).toBe("RELEASED");
  });

  it("applies session quotas to retries without creating a retry run", async () => {
    const session = await createSession();
    const failure = await seedRun({ session, status: "FAILED" });
    const limit = Number(env.SANDBOX_SESSION_HOURLY_LIMIT);
    await setSessionHourlyUsage(session.idHash, limit, limit);

    const response = await apiFetch(
      `/api/runs/${failure.runId}/retry`,
      { method: "POST" },
      session,
    );
    expect(response.status).toBe(429);
    expect((await readFailure(response)).code).toBe("SESSION_HOURLY_QUOTA");

    const runs = await env.DB.prepare(`SELECT COUNT(*) AS count FROM runs`).first<{
      count: number;
    }>();
    expect(Number(runs?.count)).toBe(1);
    expect(await countActiveLeases(env.DB, PROJECT_ID)).toBe(0);
  });

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

  it("returns structured circuit and disabled responses", async () => {
    const session = await createSession();
    const until = isoFromNow(5 * 60 * 1000);
    await env.DB.prepare(
      `UPDATE system_flags SET value = ? WHERE key = 'sandbox_circuit_open_until'`,
    )
      .bind(until)
      .run();

    const open = await launchRun(session, {}, `idem_${crypto.randomUUID()}`);
    expect(open.response.status).toBe(503);
    const openError = await readFailure(open.response);
    expect(openError.code).toBe("SANDBOX_CIRCUIT_OPEN");
    expect(openError.details).toMatchObject({ scope: "circuit", retryAt: until });
    expect(Number(open.response.headers.get("retry-after"))).toBeGreaterThan(0);

    await env.DB.prepare(
      `UPDATE system_flags SET value = '' WHERE key = 'sandbox_circuit_open_until'`,
    ).run();
    await env.DB.prepare(
      `UPDATE system_flags SET value = 'false' WHERE key = 'sandbox_enabled'`,
    ).run();

    const disabled = await launchRun(session, {}, `idem_${crypto.randomUUID()}`);
    expect(disabled.response.status).toBe(503);
    const disabledError = await readFailure(disabled.response);
    expect(disabledError.code).toBe("SANDBOX_DISABLED");
    expect(disabledError.details).toMatchObject({ scope: "sandbox" });
    // No reliable reset window exists for an operator-controlled flag.
    expect(disabled.response.headers.get("retry-after")).toBeNull();
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
  it("cancels a RUNNING run, its step and its attempt, and blocks late completion", async () => {
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

    const runningAt = isoFromNow(-60_000);
    await env.DB.prepare(
      `UPDATE runs SET status = 'RUNNING', started_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(runningAt, runningAt, runId)
      .run();

    const response = await apiFetch(`/api/runs/${runId}/cancel`, { method: "POST" }, session);
    expect(response.status).toBe(200);
    expect((await readSuccess<CancelRunResult>(response)).status).toBe("CANCELLING");

    expect(await finalizeRunCancelled(env.DB, runId)).toBe(true);

    const run = await getRunRow(env.DB, runId);
    expect(run?.status).toBe("CANCELLED");
    expect((await getStep(env.DB, runId, step.stepKey))?.status).toBe("CANCELLED");
    expect(await attemptStatus(runId, step.stepKey, 1)).toBe("ABANDONED");
    expect(await countActiveLeases(env.DB, PROJECT_ID)).toBe(0);

    const late = await completeStep(env.DB, {
      runId,
      stepId: step.id,
      stepKey: step.stepKey,
      attemptNumber: 1,
      outputJson: JSON.stringify({ value: "late" }),
      eventMessage: "late",
    });
    expect(late.changed).toBe(false);

    // Repeated finalization is a no-op, not a second terminal write.
    expect(await finalizeRunCancelled(env.DB, runId)).toBe(false);
    expect((await getRunRow(env.DB, runId))?.status).toBe("CANCELLED");
  });

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

describe("retry semantics", () => {
  it("creates a new execution and preserves the original failure", async () => {
    const session = await createSession();
    const original = await seedRun({ session, status: "FAILED" });

    const response = await apiFetch(
      `/api/runs/${original.runId}/retry`,
      { method: "POST" },
      session,
    );
    expect(response.status).toBe(202);
    const retried = await readSuccess<RetryRunResult>(response);

    expect(retried.run.id).not.toBe(original.runId);
    expect(retried.run.retryOfRunId).toBe(original.runId);
    expect(retried.originalRunId).toBe(original.runId);

    const originalDetail = await getRunDetail(session, original.runId);
    expect(originalDetail.status).toBe("FAILED");
    expect(originalDetail.error?.code).toBe("SEEDED_FAILURE");
    expect(originalDetail.retryRunId).toBe(retried.run.id);

    const second = await apiFetch(`/api/runs/${original.runId}/retry`, { method: "POST" }, session);
    expect(second.status).toBe(409);
    expect((await readFailure(second)).code).toBe("RETRY_ALREADY_EXISTS");
  });

  it("advertises only retry fields the runtime enforces", async () => {
    const session = await createSession();
    const response = await apiFetch("/api/workflows", {}, session);
    const body = await readSuccess<{ items: WorkflowSummary[] }>(response);

    const steps = body.items[0]!.steps;
    expect(steps.map((step) => step.retry.maxAttempts)).toEqual([1, 3, 3, 1, 3]);
    for (const step of steps) {
      expect(Object.keys(step.retry).sort()).toEqual(["backoff", "baseDelayMs", "maxAttempts"]);
      expect(step.retry).not.toHaveProperty("maxDelayMs");
    }
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
