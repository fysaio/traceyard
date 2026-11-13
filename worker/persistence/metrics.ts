import type { DurationStats, FailureClassCount, TrendPoint } from "../../shared/contracts/api";
import type { ErrorClass } from "../../shared/domain/errors";
import { daysAgoIso } from "../lib/time";

export async function getStatusTotals(
  db: D1Database,
  sessionHash: string,
  since: string | null = null,
  userId: string | null = null,
): Promise<Array<{ status: string; count: number }>> {
  const owner = ownershipFilter(sessionHash, userId);
  const result = await db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM runs
        WHERE ${owner.sql}
          ${since === null ? "" : "AND created_at >= ?"}
        GROUP BY status`,
    )
    .bind(...(since === null ? owner.bindings : [...owner.bindings, since]))
    .all<{ status: string; count: number }>();
  return result.results;
}

export async function getTrend(
  db: D1Database,
  sessionHash: string,
  days: number,
  userId: string | null = null,
): Promise<TrendPoint[]> {
  const since = daysAgoIso(days - 1);
  const owner = ownershipFilter(sessionHash, userId, "r.");
  const result = await db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS date, status, COUNT(*) AS count
         FROM runs r
        WHERE ${owner.sql} AND created_at >= ?
        GROUP BY date, status`,
    )
    .bind(...owner.bindings, since)
    .all<{ date: string; status: string; count: number }>();

  const byDate = new Map<string, TrendPoint>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    byDate.set(key, { date: key, total: 0, succeeded: 0, failed: 0, cancelled: 0 });
  }

  for (const row of result.results) {
    const point = byDate.get(row.date);
    if (point === undefined) continue;
    const count = Number(row.count);
    point.total += count;
    if (row.status === "SUCCEEDED") point.succeeded += count;
    else if (row.status === "FAILED") point.failed += count;
    else if (row.status === "CANCELLED") point.cancelled += count;
  }

  return [...byDate.values()];
}

export async function getFailureClasses(
  db: D1Database,
  sessionHash: string,
  since: string,
  userId: string | null = null,
): Promise<FailureClassCount[]> {
  const owner = ownershipFilter(sessionHash, userId);
  const result = await db
    .prepare(
      `SELECT error_class, COUNT(*) AS count FROM runs
        WHERE ${owner.sql}
          AND status = 'FAILED' AND error_class IS NOT NULL AND created_at >= ?
        GROUP BY error_class ORDER BY count DESC`,
    )
    .bind(...owner.bindings, since)
    .all<{ error_class: string; count: number }>();
  return result.results.map((row) => ({
    class: row.error_class as ErrorClass,
    count: Number(row.count),
  }));
}

export async function getRunTimings(
  db: D1Database,
  sessionHash: string,
  limit = 1_000,
  userId: string | null = null,
): Promise<Array<{ created_at: string; started_at: string | null; completed_at: string | null }>> {
  const owner = ownershipFilter(sessionHash, userId);
  const result = await db
    .prepare(
      `SELECT created_at, started_at, completed_at FROM runs
        WHERE ${owner.sql}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(...owner.bindings, limit)
    .all<{ created_at: string; started_at: string | null; completed_at: string | null }>();
  return result.results;
}

export async function getStepTimings(
  db: D1Database,
  sessionHash: string,
  limit = 2_000,
  userId: string | null = null,
): Promise<Array<{ step_key: string; name: string; started_at: string; completed_at: string }>> {
  const owner = ownershipFilter(sessionHash, userId, "r.");
  const result = await db
    .prepare(
      `SELECT s.step_key, s.name, s.started_at, s.completed_at
         FROM execution_steps s
         JOIN runs r ON r.id = s.run_id
        WHERE ${owner.sql}
          AND s.status = 'SUCCEEDED' AND s.started_at IS NOT NULL AND s.completed_at IS NOT NULL
        ORDER BY s.completed_at DESC LIMIT ?`,
    )
    .bind(...owner.bindings, limit)
    .all<{ step_key: string; name: string; started_at: string; completed_at: string }>();
  return result.results;
}

function ownershipFilter(
  sessionHash: string,
  userId: string | null,
  prefix = "",
): { sql: string; bindings: string[] } {
  const projectScope = userId === null ? `${prefix}project_id = 'prj_sandbox' AND ` : "";
  if (userId === null) {
    return {
      sql: `${projectScope}${prefix}owner_user_id IS NULL AND ${prefix}owner_session_hash = ?`,
      bindings: [sessionHash],
    };
  }
  return {
    sql: `${projectScope}(${prefix}owner_user_id = ? OR (${prefix}owner_user_id IS NULL AND ${prefix}owner_session_hash = ?))`,
    bindings: [userId, sessionHash],
  };
}

export function durationStats(values: number[]): DurationStats {
  if (values.length === 0) {
    return { sampleSize: 0, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const sorted = values.slice().sort((left, right) => left - right);
  const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    sampleSize: sorted.length,
    avgMs: Math.round(avg),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1] ?? null,
  };
}

function percentile(sorted: number[], percentileValue: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

export function timingDifference(
  values: Array<{ created_at: string; started_at: string | null; completed_at: string | null }>,
): { durations: number[]; queueDelays: number[] } {
  const durations: number[] = [];
  const queueDelays: number[] = [];
  for (const row of values) {
    if (row.started_at !== null) {
      const queueDelay = Date.parse(row.started_at) - Date.parse(row.created_at);
      if (Number.isFinite(queueDelay) && queueDelay >= 0) queueDelays.push(queueDelay);
    }
    if (row.started_at !== null && row.completed_at !== null) {
      const duration = Date.parse(row.completed_at) - Date.parse(row.started_at);
      if (Number.isFinite(duration) && duration >= 0) durations.push(duration);
    }
  }
  return { durations, queueDelays };
}
