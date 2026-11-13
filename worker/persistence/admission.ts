import { nowIso } from "../lib/time";

/**
 * Execution admission leases.
 *
 * Capacity is enforced with a single conditional INSERT so that concurrent
 * requests cannot both read "one slot free" and both insert. SQLite (and D1's
 * serialized write path) evaluates the subquery and the insert atomically.
 *
 * The lease is keyed by run id. That gives explicit ownership: only the run
 * that acquired the slot can release it, and releasing an unknown lease is a
 * no-op. Leases are released on every terminal transition and, as a safety
 * net, by the scheduled reconciler.
 */

export interface LeaseResult {
  acquired: boolean;
  active: number;
}

export async function acquireExecutionLease(
  db: D1Database,
  projectId: string,
  runId: string,
  limit: number,
): Promise<LeaseResult> {
  const inserted = await db
    .prepare(
      `INSERT INTO execution_leases (run_id, project_id, acquired_at)
       SELECT ?, ?, ?
        WHERE (SELECT COUNT(*) FROM execution_leases WHERE project_id = ?) < ?
       RETURNING run_id`,
    )
    .bind(runId, projectId, nowIso(), projectId, limit)
    .first<{ run_id: string }>();

  if (inserted !== null) {
    return { acquired: true, active: await countActiveLeases(db, projectId) };
  }
  return { acquired: false, active: await countActiveLeases(db, projectId) };
}

export async function releaseExecutionLease(db: D1Database, runId: string): Promise<void> {
  await db.prepare(`DELETE FROM execution_leases WHERE run_id = ?`).bind(runId).run();
}

export async function countActiveLeases(db: D1Database, projectId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM execution_leases WHERE project_id = ?`)
    .bind(projectId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/**
 * Deletes leases whose run is gone or terminal. This is intentionally narrow:
 * it never invents a slot for an active run, so it cannot oversubscribe.
 */
export async function reconcileExecutionLeases(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM execution_leases
        WHERE NOT EXISTS (
          SELECT 1 FROM runs
           WHERE runs.id = execution_leases.run_id
             AND runs.status IN ('QUEUED', 'RUNNING', 'CANCELLING')
        )`,
    )
    .run();
  return result.meta.changes;
}
