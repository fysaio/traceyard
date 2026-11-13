import { nowIso } from "../lib/time";
import type { DispatchRow } from "./rows";

export async function recordPublishSuccess(db: D1Database, dispatchId: string): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE execution_dispatches
          SET status = 'PUBLISHED', attempt_count = attempt_count + 1,
              published_at = ?, updated_at = ?, last_error = NULL
        WHERE id = ? AND status IN ('PENDING', 'PUBLISHED')`,
    )
    .bind(now, now, dispatchId)
    .run();
}

export async function recordPublishFailure(
  db: D1Database,
  dispatchId: string,
  error: string,
  retryAt: string,
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE execution_dispatches
          SET status = 'PENDING', attempt_count = attempt_count + 1,
              last_error = ?, available_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('PENDING', 'PUBLISHED')`,
    )
    .bind(error.slice(0, 500), retryAt, now, dispatchId)
    .run();
}

/**
 * Exactly one queue consumer can claim a dispatch. A duplicate delivery sees
 * zero changed rows and acknowledges the message without starting a second
 * workflow instance.
 */
export async function claimDispatch(db: D1Database, runId: string): Promise<boolean> {
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE execution_dispatches
          SET status = 'CLAIMED', claimed_at = ?, updated_at = ?
        WHERE run_id = ? AND status IN ('PENDING', 'PUBLISHED')`,
    )
    .bind(now, now, runId)
    .run();
  return result.meta.changes === 1;
}

export async function getDispatchByRunId(
  db: D1Database,
  runId: string,
): Promise<DispatchRow | null> {
  return db
    .prepare(`SELECT * FROM execution_dispatches WHERE run_id = ?`)
    .bind(runId)
    .first<DispatchRow>();
}

export async function cancelDispatch(db: D1Database, runId: string): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE execution_dispatches
          SET status = 'CANCELLED', updated_at = ?
        WHERE run_id = ? AND status IN ('PENDING', 'PUBLISHED')`,
    )
    .bind(now, runId)
    .run();
}

export async function failDispatch(
  db: D1Database,
  dispatchId: string,
  error: string,
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE execution_dispatches
          SET status = 'FAILED', last_error = ?, updated_at = ?
        WHERE id = ? AND status IN ('PENDING', 'PUBLISHED', 'CLAIMED')`,
    )
    .bind(error.slice(0, 500), now, dispatchId)
    .run();
}

export async function listDispatchesForReconciliation(
  db: D1Database,
  now: string,
  limit: number,
): Promise<DispatchRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM execution_dispatches
        WHERE status IN ('PENDING', 'PUBLISHED')
          AND available_at <= ?
          AND attempt_count < 6
        ORDER BY available_at ASC
        LIMIT ?`,
    )
    .bind(now, limit)
    .all<DispatchRow>();
  return result.results;
}

export async function postponeDispatch(
  db: D1Database,
  dispatchId: string,
  availableAt: string,
  error: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE execution_dispatches
          SET available_at = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status IN ('PENDING', 'PUBLISHED')`,
    )
    .bind(availableAt, error.slice(0, 500), nowIso(), dispatchId)
    .run();
}

/**
 * A consumer claims a dispatch before creating the Workflow instance. If
 * instance creation fails, the claim is released so at-least-once delivery and
 * the reconciliation job can retry it.
 */
export async function reopenDispatch(db: D1Database, runId: string, error: string): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE execution_dispatches
          SET status = 'PUBLISHED', available_at = ?, last_error = ?, updated_at = ?
        WHERE run_id = ? AND status = 'CLAIMED'`,
    )
    .bind(now, error.slice(0, 500), now, runId)
    .run();
}

export async function reopenStaleClaims(db: D1Database, staleBefore: string): Promise<number> {
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE execution_dispatches
          SET status = 'PUBLISHED', available_at = ?, last_error = 'Reopened stale claim.',
              updated_at = ?
        WHERE status = 'CLAIMED' AND claimed_at < ?`,
    )
    .bind(now, now, staleBefore)
    .run();
  return result.meta.changes;
}
