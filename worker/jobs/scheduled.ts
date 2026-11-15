import { runIntegrationJobs } from "./integrations";
import { DomainError, serializeError } from "../../shared/domain/errors";
import { isoFromNow, nowIso } from "../lib/time";
import { log, logError } from "../observability/logger";
import { appendAudit } from "../persistence/audit";
import { reconcileExecutionLeases } from "../persistence/admission";
import {
  failDispatch,
  listDispatchesForReconciliation,
  reopenStaleClaims,
} from "../persistence/dispatches";
import {
  deleteResolvedQuotaReservations,
  getFlag,
  reconcileQuotaReservations,
  setFlag,
} from "../persistence/quotas";
import { getRunRow } from "../persistence/runs";
import { finalizeRunFailure } from "../execution/finalize";
import { publishDispatch } from "../queue/producer";
import type { DispatchRow, RunRow } from "../persistence/rows";

export interface ScheduledSummary {
  reconciledExecutionLeases: number;
  committedQuotaReservations: number;
  releasedQuotaReservations: number;
  republished: number;
  reopenedClaims: number;
  failedDispatches: number;
  failedStaleRuns: number;
  deletedRuns: number;
  circuitOpened: boolean;
}

const QUEUED_TIMEOUT_MS = 15 * 60 * 1000;
const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Scheduled maintenance. Runs every five minutes and performs only bounded work
 * per invocation so it remains within free-tier limits.
 */
export async function runScheduledJobs(env: Env): Promise<ScheduledSummary> {
  const summary: ScheduledSummary = {
    reconciledExecutionLeases: 0,
    committedQuotaReservations: 0,
    releasedQuotaReservations: 0,
    republished: 0,
    reopenedClaims: 0,
    failedDispatches: 0,
    failedStaleRuns: 0,
    deletedRuns: 0,
    circuitOpened: false,
  };

  summary.reconciledExecutionLeases = await reconcileExecutionLeases(env.DB);
  const reservations = await reconcileQuotaReservations(env.DB, isoFromNow(-STALE_CLAIM_MS));
  summary.committedQuotaReservations = reservations.committed;
  summary.releasedQuotaReservations = reservations.released;
  summary.reopenedClaims = await reopenStaleClaims(env.DB, isoFromNow(-STALE_CLAIM_MS));
  summary.republished = await republishPendingDispatches(env);
  summary.failedDispatches = await failExhaustedDispatches(env);
  summary.failedStaleRuns = await failStaleQueuedRuns(env);
  summary.deletedRuns = await cleanupExpiredData(env.DB);
  summary.circuitOpened = await updateCircuitBreaker(env);
  await runIntegrationJobs(env);

  log("info", "scheduled.reconcile", { ...summary });
  return summary;
}

async function republishPendingDispatches(env: Env): Promise<number> {
  const rows = await listDispatchesForReconciliation(env.DB, nowIso(), 50);
  let republished = 0;

  for (const dispatch of rows) {
    const run = await getRunRow(env.DB, dispatch.run_id);
    if (run === null) {
      await failDispatch(env.DB, dispatch.id, "Run no longer exists.");
      continue;
    }
    if (run.status !== "QUEUED") {
      // The workflow has already started or the run is terminal. Close the
      // dispatch outbox so the reconciler stops selecting it.
      await env.DB.prepare(
        `UPDATE execution_dispatches
              SET status = 'CLAIMED', claimed_at = COALESCE(claimed_at, ?), updated_at = ?
            WHERE id = ? AND status IN ('PENDING', 'PUBLISHED')`,
      )
        .bind(nowIso(), nowIso(), dispatch.id)
        .run();
      continue;
    }
    if (dispatch.attempt_count >= 5) {
      continue;
    }
    await publishDispatch(env, env.DB, dispatch, "scheduled-reconciler");
    republished += 1;
  }

  return republished;
}

async function failExhaustedDispatches(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    `SELECT d.*, r.id AS joined_run_id
         FROM execution_dispatches d
         JOIN runs r ON r.id = d.run_id
        WHERE d.status IN ('PENDING', 'PUBLISHED')
          AND d.attempt_count >= 6
          AND r.status = 'QUEUED'
        LIMIT 25`,
  ).all<DispatchRow>();
  let failed = 0;

  for (const dispatch of result.results) {
    const run = await getRunRow(env.DB, dispatch.run_id);
    if (run === null) continue;
    await failQueuedRun(
      env,
      run,
      "DISPATCH_EXHAUSTED",
      "Execution dispatch could not be delivered.",
    );
    await failDispatch(env.DB, dispatch.id, "Dispatch attempts exhausted.");
    failed += 1;
  }
  return failed;
}

async function failStaleQueuedRuns(env: Env): Promise<number> {
  const staleBefore = isoFromNow(-QUEUED_TIMEOUT_MS);
  const result = await env.DB.prepare(
    `SELECT * FROM runs
        WHERE status = 'QUEUED' AND created_at < ?
        ORDER BY created_at ASC LIMIT 25`,
  )
    .bind(staleBefore)
    .all<RunRow>();

  let failed = 0;
  for (const run of result.results) {
    await failQueuedRun(
      env,
      run,
      "DISPATCH_TIMEOUT",
      "The run remained queued beyond its dispatch timeout.",
    );
    failed += 1;
  }
  return failed;
}

async function failQueuedRun(env: Env, run: RunRow, code: string, message: string): Promise<void> {
  const error = new DomainError({
    errorClass: "EXECUTION_INFRASTRUCTURE",
    code,
    message,
    retryable: false,
  });
  const serialized = serializeError(error);
  await finalizeRunFailure(
    env.DB,
    run.id,
    JSON.stringify(serialized),
    "EXECUTION_INFRASTRUCTURE",
    message,
  );
  await appendAudit(env.DB, {
    projectId: run.project_id,
    actorType: "system",
    actorIdHash: null,
    action: "run.dispatch_failed",
    targetType: "run",
    targetId: run.id,
    metadata: { code },
    requestId: "scheduled-reconciler",
  });
  logError("run.dispatch_failed", error, { runId: run.id, code });
}

async function cleanupExpiredData(db: D1Database): Promise<number> {
  const now = nowIso();
  // D1 reports cascaded rows in `meta.changes`, so use RETURNING to count the
  // runs that were actually deleted rather than their dependent rows.
  const deleted = await db
    .prepare(
      `DELETE FROM runs
        WHERE id IN (SELECT id FROM runs WHERE expires_at < ? LIMIT 100)
        RETURNING id`,
    )
    .bind(now)
    .all<{ id: string }>();
  await db.prepare(`DELETE FROM idempotency_records WHERE expires_at < ?`).bind(now).run();
  await db.prepare(`DELETE FROM quota_counters WHERE expires_at < ?`).bind(now).run();
  await db
    .prepare(`DELETE FROM audit_events WHERE created_at < ?`)
    .bind(isoFromNow(-90 * 24 * 60 * 60 * 1000))
    .run();
  await deleteResolvedQuotaReservations(db, isoFromNow(-30 * 24 * 60 * 60 * 1000));
  await db
    .prepare(
      `DELETE FROM user_sessions
        WHERE expires_at < ? OR revoked_at < ?`,
    )
    .bind(now, isoFromNow(-90 * 24 * 60 * 60 * 1000))
    .run();
  await db.prepare(`DELETE FROM github_oauth_states WHERE expires_at < ?`).bind(now).run();
  await db
    .prepare(`DELETE FROM sandbox_sessions WHERE last_seen_at < ?`)
    .bind(isoFromNow(-180 * 24 * 60 * 60 * 1000))
    .run();
  return deleted.results.length;
}

async function updateCircuitBreaker(env: Env): Promise<boolean> {
  const windowStart = isoFromNow(-10 * 60 * 1000);
  const [infraRuns, failedDispatches, retryHeavyDispatches, existingFlag] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM runs
          WHERE project_id = 'prj_sandbox' AND status = 'FAILED'
            AND error_class = 'EXECUTION_INFRASTRUCTURE' AND completed_at >= ?`,
    )
      .bind(windowStart)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM execution_dispatches
          WHERE status = 'FAILED' AND updated_at >= ?`,
    )
      .bind(windowStart)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM execution_dispatches
          WHERE attempt_count >= 3 AND updated_at >= ?`,
    )
      .bind(windowStart)
      .first<{ count: number }>(),
    getFlag(env.DB, "sandbox_circuit_open_until"),
  ]);

  const signalCount =
    Number(infraRuns?.count ?? 0) +
    Number(failedDispatches?.count ?? 0) +
    Number(retryHeavyDispatches?.count ?? 0);

  if (signalCount >= 3) {
    const openUntil = isoFromNow(10 * 60 * 1000);
    await setFlag(env.DB, "sandbox_circuit_open_until", openUntil);
    if (existingFlag === null || existingFlag === "" || Date.parse(existingFlag) <= Date.now()) {
      await appendAudit(env.DB, {
        projectId: "prj_sandbox",
        actorType: "system",
        actorIdHash: null,
        action: "sandbox.circuit_opened",
        targetType: "sandbox",
        targetId: null,
        metadata: { signalCount, openUntil },
        requestId: "scheduled-reconciler",
      });
      log("warn", "sandbox.circuit_opened", { signalCount, openUntil });
    }
    return true;
  }

  if (existingFlag !== null && existingFlag !== "" && Date.parse(existingFlag) <= Date.now()) {
    await setFlag(env.DB, "sandbox_circuit_open_until", "");
    log("info", "sandbox.circuit_closed", { previous: existingFlag });
  }
  return false;
}
