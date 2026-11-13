import type { RunStatus } from "../../shared/domain/status";
import { nowIso } from "../lib/time";
import type {
  AttemptRow,
  DispatchRow,
  DispatchSummaryRow,
  EventRow,
  RunRow,
  RunWithWorkflowRow,
  StepRow,
  StepStatusCountRow,
} from "./rows";

const RUN_SELECT = `SELECT r.*, w.slug AS workflow_slug, w.name AS workflow_name,
                            w.project_id AS workflow_project_id
                       FROM runs r JOIN workflows w ON w.id = r.workflow_id`;

export interface ListRunsOptions {
  projectId?: string | null | undefined;
  sessionHash: string;
  userId?: string | null | undefined;
  status?: RunStatus | undefined;
  workflowId?: string | undefined;
  cursor: { createdAt: string; id: string } | null;
  limit: number;
}

export async function listRuns(
  db: D1Database,
  options: ListRunsOptions,
): Promise<RunWithWorkflowRow[]> {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (options.projectId !== undefined && options.projectId !== null) {
    conditions.push("r.project_id = ?");
    bindings.push(options.projectId);
  }
  if (options.userId !== undefined && options.userId !== null) {
    conditions.push(
      "(r.owner_user_id = ? OR (r.owner_user_id IS NULL AND (r.owner_session_hash = ? OR r.visibility = 'public')))",
    );
    bindings.push(options.userId, options.sessionHash);
  } else {
    conditions.push(
      "(r.owner_user_id IS NULL AND (r.owner_session_hash = ? OR r.visibility = 'public'))",
    );
    bindings.push(options.sessionHash);
  }

  if (options.status !== undefined) {
    conditions.push("r.status = ?");
    bindings.push(options.status);
  }
  if (options.workflowId !== undefined) {
    conditions.push("(r.workflow_id = ? OR w.slug = ?)");
    bindings.push(options.workflowId, options.workflowId);
  }
  if (options.cursor !== null) {
    conditions.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
    bindings.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
  }

  const rows = await db
    .prepare(
      `${RUN_SELECT}
        WHERE ${conditions.join(" AND ")}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ?`,
    )
    .bind(...bindings, options.limit)
    .all<RunWithWorkflowRow>();

  return rows.results;
}

export async function getRunForSession(
  db: D1Database,
  runId: string,
  projectId: string | null,
  sessionHash: string,
  userId: string | null = null,
): Promise<RunWithWorkflowRow | null> {
  const projectCondition = projectId === null ? "" : "AND r.project_id = ?";
  const ownerCondition =
    userId === null
      ? "(r.owner_user_id IS NULL AND (r.owner_session_hash = ? OR r.visibility = 'public'))"
      : "(r.owner_user_id = ? OR (r.owner_user_id IS NULL AND (r.owner_session_hash = ? OR r.visibility = 'public')))";
  const bindings =
    userId === null
      ? [runId, ...(projectId === null ? [] : [projectId]), sessionHash]
      : [
          runId,
          ...(projectId === null ? [] : [projectId]),
          userId,
          sessionHash,
        ];
  return db
    .prepare(
      `${RUN_SELECT}
        WHERE r.id = ? ${projectCondition}
          AND ${ownerCondition}`,
    )
    .bind(...bindings)
    .first<RunWithWorkflowRow>();
}

export async function getRunRow(db: D1Database, runId: string): Promise<RunRow | null> {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).bind(runId).first<RunRow>();
}

export async function getRunForOwner(
  db: D1Database,
  runId: string,
  sessionHash: string,
  userId: string | null = null,
): Promise<RunRow | null> {
  const query =
    userId === null
      ? `SELECT * FROM runs
          WHERE id = ? AND owner_user_id IS NULL AND owner_session_hash = ?`
      : `SELECT * FROM runs
          WHERE id = ? AND (
            owner_user_id = ? OR (owner_user_id IS NULL AND owner_session_hash = ?)
          )`;
  const bindings = userId === null ? [runId, sessionHash] : [runId, userId, sessionHash];
  return db
    .prepare(query)
    .bind(...bindings)
    .first<RunRow>();
}

export async function getStepStatusCounts(
  db: D1Database,
  runIds: string[],
): Promise<StepStatusCountRow[]> {
  if (runIds.length === 0) return [];
  const placeholders = runIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT run_id, status, COUNT(*) AS count
         FROM execution_steps
        WHERE run_id IN (${placeholders})
        GROUP BY run_id, status`,
    )
    .bind(...runIds)
    .all<StepStatusCountRow>();
  return result.results;
}

export async function getSteps(db: D1Database, runId: string): Promise<StepRow[]> {
  const result = await db
    .prepare(`SELECT * FROM execution_steps WHERE run_id = ? ORDER BY ordinal ASC`)
    .bind(runId)
    .all<StepRow>();
  return result.results;
}

export async function getAttempts(db: D1Database, runId: string): Promise<AttemptRow[]> {
  const result = await db
    .prepare(`SELECT * FROM step_attempts WHERE run_id = ? ORDER BY attempt_number ASC`)
    .bind(runId)
    .all<AttemptRow>();
  return result.results;
}

export async function getDispatch(db: D1Database, runId: string): Promise<DispatchRow | null> {
  return db
    .prepare(`SELECT * FROM execution_dispatches WHERE run_id = ?`)
    .bind(runId)
    .first<DispatchRow>();
}

export async function getDispatchSummaries(
  db: D1Database,
  runIds: string[],
): Promise<DispatchSummaryRow[]> {
  if (runIds.length === 0) return [];
  const placeholders = runIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT run_id, status, attempt_count, last_error, published_at, claimed_at
         FROM execution_dispatches WHERE run_id IN (${placeholders})`,
    )
    .bind(...runIds)
    .all<DispatchSummaryRow>();
  return result.results;
}

export async function getEvents(
  db: D1Database,
  runId: string,
  after: number,
  limit: number,
): Promise<EventRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM execution_events
        WHERE run_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?`,
    )
    .bind(runId, after, limit)
    .all<EventRow>();
  return result.results;
}

export async function getAllEvents(db: D1Database, runId: string): Promise<EventRow[]> {
  const result = await db
    .prepare(`SELECT * FROM execution_events WHERE run_id = ? ORDER BY seq ASC`)
    .bind(runId)
    .all<EventRow>();
  return result.results;
}

/* ------------------------------------------------------------------------- */
/* Transitions                                                                */
/* ------------------------------------------------------------------------- */

export async function markRunRunning(db: D1Database, runId: string): Promise<boolean> {
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE runs
          SET status = 'RUNNING', started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND status = 'QUEUED'`,
    )
    .bind(now, now, runId)
    .run();
  return result.meta.changes === 1;
}

export async function markRunSucceeded(
  db: D1Database,
  runId: string,
  outputJson: string,
): Promise<boolean> {
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE runs
          SET status = 'SUCCEEDED', output_json = ?, completed_at = ?, updated_at = ?,
              error_json = NULL, error_class = NULL
        WHERE id = ? AND status = 'RUNNING'`,
    )
    .bind(outputJson, now, now, runId)
    .run();
  return result.meta.changes === 1;
}

export async function markRunFailed(
  db: D1Database,
  runId: string,
  errorJson: string,
  errorClass: string,
): Promise<boolean> {
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE runs
          SET status = 'FAILED', error_json = ?, error_class = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('QUEUED', 'RUNNING', 'CANCELLING')`,
    )
    .bind(errorJson, errorClass, now, now, runId)
    .run();
  return result.meta.changes === 1;
}

export async function markRunCancelled(db: D1Database, runId: string): Promise<boolean> {
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE runs
          SET status = 'CANCELLED', completed_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('RUNNING', 'CANCELLING')`,
    )
    .bind(now, now, runId)
    .run();
  return result.meta.changes === 1;
}

export async function requestCancellation(db: D1Database, runId: string): Promise<boolean> {
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE runs
          SET status = 'CANCELLING', cancel_requested_at = ?, updated_at = ?
        WHERE id = ? AND status = 'RUNNING'`,
    )
    .bind(now, now, runId)
    .run();
  return result.meta.changes === 1;
}

export async function cancelQueuedRun(db: D1Database, runId: string): Promise<boolean> {
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE runs
          SET status = 'CANCELLED', cancel_requested_at = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'QUEUED'`,
    )
    .bind(now, now, now, runId)
    .run();
  return result.meta.changes === 1;
}

export async function skipPendingSteps(db: D1Database, runId: string): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE execution_steps
          SET status = 'SKIPPED', updated_at = ?, completed_at = ?
        WHERE run_id = ? AND status = 'PENDING'`,
    )
    .bind(now, now, runId)
    .run();
}

export async function markAbandonedAttempts(db: D1Database, runId: string): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE step_attempts
          SET status = 'ABANDONED', completed_at = ?
        WHERE run_id = ? AND status = 'RUNNING'`,
    )
    .bind(now, runId)
    .run();
}

export async function setRetryRunId(
  db: D1Database,
  originalRunId: string,
  retryRunId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE runs SET retry_run_id = ?, updated_at = ?
        WHERE id = ? AND status = 'FAILED' AND retry_run_id IS NULL`,
    )
    .bind(retryRunId, nowIso(), originalRunId)
    .run();
  return result.meta.changes === 1;
}

export async function countActiveRuns(db: D1Database, projectId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM runs
        WHERE project_id = ? AND status IN ('QUEUED', 'RUNNING', 'CANCELLING')`,
    )
    .bind(projectId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}
