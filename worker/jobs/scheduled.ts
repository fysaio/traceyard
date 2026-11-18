import { maintainInvestigations } from "../services/investigation-maintenance";
import { runIntegrationJobs } from "./integrations";
import { reapManagedChecks } from "../repositories/managed";
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
  reconciledStaleRunning: number;
  deletedRuns: number;
  deletedSessions: number;
  circuitOpened: boolean;
}

const QUEUED_TIMEOUT_MS = 15 * 60 * 1000;
const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * A RUNNING run whose progress timestamp is older than this is no longer
 * plausibly executing. The longest legitimate path is five steps with a 15s
 * timeout each (~75s), and retry delays are bounded to seconds, so ten minutes
 * is an order of magnitude above any healthy execution.
 *
 * Cloudflare Workflows exposes no API for reading an instance's live state, so
 * the reconciler cannot prove that an instance is dead. It therefore fails the
 * run with an explicit *uncertain* outcome instead of pretending the execution
 * definitely failed.
 */
const STALE_RUNNING_MS = 10 * 60 * 1000;

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
    reconciledStaleRunning: 0,
    deletedRuns: 0,
    deletedSessions: 0,
    circuitOpened: false,
  };

  summary.reconciledExecutionLeases = await reconcileExecutionLeases(env.DB);
  await reapManagedChecks(env);
  await maintainInvestigations(env.DB);
  const reservations = await reconcileQuotaReservations(env.DB, isoFromNow(-STALE_CLAIM_MS));
  summary.committedQuotaReservations = reservations.committed;
  summary.releasedQuotaReservations = reservations.released;
  summary.reopenedClaims = await reopenStaleClaims(env.DB, isoFromNow(-STALE_CLAIM_MS));
  summary.reconciledStaleRunning = await reconcileStaleRunningRuns(env);
  summary.republished = await republishPendingDispatches(env);
  summary.failedDispatches = await failExhaustedDispatches(env);
  summary.failedStaleRuns = await failStaleQueuedRuns(env);
  const cleanup = await cleanupExpiredData(env.DB);
  summary.deletedRuns = cleanup.runs;
  summary.deletedSessions = cleanup.sessions;
  summary.circuitOpened = await updateCircuitBreaker(env);
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM managed_repository_checks WHERE state IN ('FINISHED','CANCELLED') AND created_at<?",
    ).bind(isoFromNow(-30 * 24 * 60 * 60 * 1000)),
    env.DB.prepare("DELETE FROM github_check_dispatches WHERE created_at<?").bind(
      isoFromNow(-30 * 24 * 60 * 60 * 1000),
    ),
    env.DB.prepare("DELETE FROM repository_check_requests WHERE created_at<?").bind(
      isoFromNow(-30 * 24 * 60 * 60 * 1000),
    ),
    env.DB.prepare("DELETE FROM repository_test_results WHERE created_at<?").bind(
      isoFromNow(-30 * 24 * 60 * 60 * 1000),
    ),
  ]);
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

/**
 * Recovers RUNNING runs that have stopped making progress.
 *
 * The update is fenced on the exact `updated_at` value read by the query, so a
 * run that completed, failed or was cancelled between the read and the write
 * cannot be overwritten. Every dependent write (steps, attempts, lease, event)
 * is gated on the same fenced transition.
 */
async function reconcileStaleRunningRuns(env: Env): Promise<number> {
  const staleBefore = isoFromNow(-STALE_RUNNING_MS);
  const result = await env.DB.prepare(
    `SELECT * FROM runs
        WHERE status = 'RUNNING' AND updated_at < ?
        ORDER BY updated_at ASC LIMIT 25`,
  )
    .bind(staleBefore)
    .all<RunRow>();

  const message =
    "Execution progress stopped and the runtime could not confirm the outcome. " +
    "The run was closed as uncertain; retrying creates a new execution.";

  let reconciled = 0;
  for (const run of result.results) {
    const error = new DomainError({
      errorClass: "EXECUTION_INFRASTRUCTURE",
      code: "EXECUTION_OUTCOME_UNKNOWN",
      message,
      retryable: false,
    });
    const errorJson = JSON.stringify(serializeError(error));
    const now = nowIso();

    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE runs
            SET status = 'FAILED', error_json = ?, error_class = 'EXECUTION_INFRASTRUCTURE',
                completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'RUNNING' AND updated_at = ?`,
      ).bind(errorJson, now, now, run.id, run.updated_at),
      env.DB.prepare(
        `UPDATE execution_steps
            SET status = 'FAILED', error_json = ?, error_class = 'EXECUTION_INFRASTRUCTURE',
                completed_at = ?, updated_at = ?
          WHERE run_id = ? AND status = 'RUNNING'
            AND EXISTS (
              SELECT 1 FROM runs WHERE id = ? AND status = 'FAILED' AND updated_at = ?
            )`,
      ).bind(errorJson, now, now, run.id, run.id, now),
      env.DB.prepare(
        `UPDATE step_attempts SET status = 'ABANDONED', completed_at = ?
          WHERE run_id = ? AND status = 'RUNNING'
            AND EXISTS (
              SELECT 1 FROM runs WHERE id = ? AND status = 'FAILED' AND updated_at = ?
            )`,
      ).bind(now, run.id, run.id, now),
      env.DB.prepare(
        `DELETE FROM execution_leases
          WHERE run_id = ?
            AND EXISTS (
              SELECT 1 FROM runs WHERE id = ? AND status = 'FAILED' AND updated_at = ?
            )`,
      ).bind(run.id, run.id, now),
      env.DB.prepare(
        `INSERT INTO execution_events (
           run_id, type, level, message, data_json, dedupe_key, created_at
         ) VALUES (?, 'run.reconciled.uncertain', 'error', ?, ?, ?, ?)
         ON CONFLICT (dedupe_key) DO NOTHING`,
      ).bind(
        run.id,
        message,
        JSON.stringify({ code: "EXECUTION_OUTCOME_UNKNOWN", uncertain: true }),
        `${run.id}:run.reconciled.uncertain`,
        now,
      ),
    ]);

    if ((results[0]?.meta.changes ?? 0) !== 1) continue;
    reconciled += 1;
    await appendAudit(env.DB, {
      projectId: run.project_id,
      actorType: "system",
      actorIdHash: null,
      action: "run.reconciled_uncertain",
      targetType: "run",
      targetId: run.id,
      metadata: { code: "EXECUTION_OUTCOME_UNKNOWN", staleBefore },
      requestId: "scheduled-reconciler",
    });
    logError("run.reconciled_uncertain", error, { runId: run.id, staleBefore });
  }

  await repairTerminalSteps(env.DB);
  return reconciled;
}

/**
 * Restores the invariant that a terminal run never owns a RUNNING step or a
 * RUNNING attempt. This also repairs rows left by older code.
 */
async function repairTerminalSteps(db: D1Database): Promise<void> {
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE execution_steps SET status = 'CANCELLED', completed_at = ?, updated_at = ?
          WHERE status = 'RUNNING'
            AND EXISTS (
              SELECT 1 FROM runs WHERE id = execution_steps.run_id AND status = 'CANCELLED'
            )`,
      )
      .bind(now, now),
    db
      .prepare(
        `UPDATE step_attempts SET status = 'ABANDONED', completed_at = ?
          WHERE status = 'RUNNING'
            AND EXISTS (
              SELECT 1 FROM runs
               WHERE id = step_attempts.run_id
                 AND status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
            )`,
      )
      .bind(now),
  ]);
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

async function cleanupExpiredData(db: D1Database): Promise<{ runs: number; sessions: number }> {
  const now = nowIso();
  await db
    .prepare("DELETE FROM github_webhook_deliveries WHERE received_at<?")
    .bind(isoFromNow(-30 * 24 * 60 * 60 * 1000))
    .run();
  await db
    .prepare("DELETE FROM repository_jobs WHERE updated_at<?")
    .bind(isoFromNow(-30 * 24 * 60 * 60 * 1000))
    .run();
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
  // Anonymous sessions are deleted once they are clearly obsolete:
  //  - older than the run retention horizon (their runs are already gone), or
  //  - inactive for 30 days and never owned a run.
  // Sessions that still own unexpired runs are retained so history stays
  // reachable. The range scan uses idx_sandbox_sessions_seen.
  const sessions = await db
    .prepare(
      `DELETE FROM sandbox_sessions
        WHERE last_seen_at < ?
           OR (
             last_seen_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM runs WHERE runs.owner_session_hash = sandbox_sessions.id_hash
             )
           )`,
    )
    .bind(isoFromNow(-180 * 24 * 60 * 60 * 1000), isoFromNow(-30 * 24 * 60 * 60 * 1000))
    .run();

  return { runs: deleted.results.length, sessions: sessions.meta.changes };
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
