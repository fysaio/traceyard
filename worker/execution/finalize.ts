import type { ErrorClass } from "../../shared/domain/errors";
import { nowIso } from "../lib/time";
import { eventInsertStatement } from "../persistence/events";
import { getRunRow } from "../persistence/runs";
import type { RunRow } from "../persistence/rows";
import type { RunStatus } from "../../shared/domain/status";

export async function beginRun(
  db: D1Database,
  runId: string,
  correlationId: string,
): Promise<{ started: boolean; run: RunRow | null; status: RunStatus | null }> {
  const now = nowIso();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE runs
            SET status = 'RUNNING', started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE id = ? AND status = 'QUEUED'`,
      )
      .bind(now, now, runId),
    eventInsertStatement(db, {
      runId,
      type: "run.started",
      level: "info",
      message: "Execution engine started the run.",
      data: { correlationId },
      dedupeKey: `${runId}:run.started`,
      createdAt: now,
    }),
  ]);

  const run = await getRunRow(db, runId);
  return {
    started: (results[0]?.meta.changes ?? 0) === 1,
    run,
    status: run?.status ?? null,
  };
}

export async function finalizeRunSuccess(
  db: D1Database,
  runId: string,
  outputJson: string,
  meta: { digest: string },
): Promise<boolean> {
  const now = nowIso();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE runs
            SET status = 'SUCCEEDED', output_json = ?, completed_at = ?, updated_at = ?,
                error_json = NULL, error_class = NULL
          WHERE id = ? AND status = 'RUNNING'`,
      )
      .bind(outputJson, now, now, runId),
    eventInsertStatement(db, {
      runId,
      type: "run.succeeded",
      level: "info",
      message: "Run completed successfully; all required steps were verified.",
      data: { digest: meta.digest },
      dedupeKey: `${runId}:run.succeeded`,
      createdAt: now,
    }),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

export async function finalizeRunFailure(
  db: D1Database,
  runId: string,
  errorJson: string,
  errorClass: ErrorClass,
  message: string,
): Promise<boolean> {
  const now = nowIso();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE runs
            SET status = 'FAILED', error_json = ?, error_class = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('QUEUED', 'RUNNING', 'CANCELLING')`,
      )
      .bind(errorJson, errorClass, now, now, runId),
    db
      .prepare(
        `UPDATE execution_steps
            SET status = 'FAILED', error_json = ?, error_class = ?, completed_at = ?, updated_at = ?
          WHERE run_id = ? AND status = 'RUNNING'`,
      )
      .bind(errorJson, errorClass, now, now, runId),
    db
      .prepare(
        `UPDATE step_attempts SET status = 'ABANDONED', completed_at = ?
          WHERE run_id = ? AND status = 'RUNNING'`,
      )
      .bind(now, runId),
    eventInsertStatement(db, {
      runId,
      type: "run.failed",
      level: "error",
      message,
      data: JSON.parse(errorJson) as unknown,
      dedupeKey: `${runId}:run.failed`,
      createdAt: now,
    }),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

export async function finalizeRunCancelled(
  db: D1Database,
  runId: string,
  message = "Run cancelled at an execution checkpoint.",
): Promise<boolean> {
  const now = nowIso();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE runs
            SET status = 'CANCELLED', completed_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('RUNNING', 'CANCELLING')`,
      )
      .bind(now, now, runId),
    db
      .prepare(
        `UPDATE execution_steps SET status = 'SKIPPED', completed_at = ?, updated_at = ?
          WHERE run_id = ? AND status = 'PENDING'`,
      )
      .bind(now, now, runId),
    db
      .prepare(
        `UPDATE step_attempts SET status = 'ABANDONED', completed_at = ?
          WHERE run_id = ? AND status = 'RUNNING'`,
      )
      .bind(now, runId),
    eventInsertStatement(db, {
      runId,
      type: "run.cancelled",
      level: "warn",
      message,
      dedupeKey: `${runId}:run.cancelled`,
      createdAt: now,
    }),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}
