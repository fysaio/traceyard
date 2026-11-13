import { nowIso } from "../lib/time";
import type { SandboxStatus } from "../../shared/contracts/api";
import { countActiveLeases } from "./admission";

/**
 * Quota counters are shared server-side state. Each bucket key embeds its
 * window (for example `session:<hash>:hour:2026-11-13T09`), so a new window
 * creates a new row rather than requiring a read-modify-write reset.
 */
export async function reserveQuota(
  db: D1Database,
  runId: string,
  options: {
    bucketKey: string;
    limit: number;
    windowStart: string;
    expiresAt: string;
  },
): Promise<{ allowed: boolean; count: number }> {
  const now = nowIso();
  const [reservation] = await db.batch([
    db
      .prepare(
        `INSERT INTO quota_counters (
           bucket_key, count, limit_value, window_start, expires_at, updated_at
         ) VALUES (?, 1, ?, ?, ?, ?)
         ON CONFLICT (bucket_key) DO UPDATE SET
           count = quota_counters.count + 1,
           limit_value = excluded.limit_value,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at
         WHERE quota_counters.count < excluded.limit_value
         RETURNING count`,
      )
      .bind(options.bucketKey, options.limit, options.windowStart, options.expiresAt, now),
    db
      .prepare(
        `INSERT INTO quota_reservation_buckets (run_id, bucket_key)
         SELECT ?, ? WHERE changes() = 1
           AND EXISTS (
             SELECT 1 FROM quota_reservations
              WHERE run_id = ? AND status = 'PENDING'
           )
         ON CONFLICT (run_id, bucket_key) DO NOTHING`,
      )
      .bind(runId, options.bucketKey, runId),
  ]);

  if ((reservation?.meta.changes ?? 0) === 0) {
    const current = await getQuotaCount(db, options.bucketKey);
    return { allowed: false, count: current };
  }
  return { allowed: true, count: await getQuotaCount(db, options.bucketKey) };
}

export async function releaseQuota(db: D1Database, bucketKey: string): Promise<void> {
  await db
    .prepare(
      `UPDATE quota_counters SET count = count - 1, updated_at = ?
        WHERE bucket_key = ? AND count > 0`,
    )
    .bind(nowIso(), bucketKey)
    .run();
}

export async function getQuotaCount(db: D1Database, bucketKey: string): Promise<number> {
  const row = await db
    .prepare(`SELECT count FROM quota_counters WHERE bucket_key = ?`)
    .bind(bucketKey)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/* ------------------------------------------------------------------------- */
/* Reservation ledger                                                         */
/* ------------------------------------------------------------------------- */

export interface QuotaBucket {
  key: string;
  limit: number;
  windowStart: string;
  expiresAt: string;
  reason: string;
  retryAfterSeconds: number;
}

/**
 * Records the intent to consume the supplied buckets. The row is written
 * before any counter is incremented. If the process dies mid-reservation the
 * reconciler observes PENDING, checks whether the run exists, and either
 * commits or releases exactly once.
 */
export async function createQuotaReservation(db: D1Database, runId: string): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO quota_reservations (run_id, status, created_at, updated_at)
       VALUES (?, 'PENDING', ?, ?)
       ON CONFLICT (run_id) DO NOTHING`,
    )
    .bind(runId, now, now)
    .run();
}

export async function commitQuotaReservation(db: D1Database, runId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE quota_reservations SET status = 'COMMITTED', updated_at = ?
        WHERE run_id = ? AND status = 'PENDING'`,
    )
    .bind(nowIso(), runId)
    .run();
  return result.meta.changes === 1;
}

/**
 * Releases every bucket exactly once. The decrements are guarded by the
 * reservation still being PENDING inside the same transactional batch, so a
 * concurrent or repeated release cannot decrement twice.
 */
export async function releaseQuotaReservation(
  db: D1Database,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .prepare(
      `SELECT bucket_key FROM quota_reservation_buckets
        WHERE run_id = ? AND EXISTS (
          SELECT 1 FROM quota_reservations
           WHERE run_id = ? AND status = 'PENDING'
        )`,
    )
    .bind(runId, runId)
    .all<{ bucket_key: string }>();
  if (rows.results.length === 0) {
    const pending = await db
      .prepare(`SELECT 1 AS pending FROM quota_reservations WHERE run_id = ? AND status = 'PENDING'`)
      .bind(runId)
      .first<{ pending: number }>();
    if (pending === null) return false;
  }

  const now = nowIso();
  const statements: D1PreparedStatement[] = rows.results.map(({ bucket_key: bucketKey }) =>
    db
      .prepare(
        `UPDATE quota_counters SET count = count - 1, updated_at = ?
          WHERE bucket_key = ? AND count > 0
            AND EXISTS (
              SELECT 1 FROM quota_reservations
               WHERE run_id = ? AND status = 'PENDING'
            )`,
      )
      .bind(now, bucketKey, runId),
  );
  statements.push(
    db
      .prepare(
        `UPDATE quota_reservations SET status = 'RELEASED', updated_at = ?
          WHERE run_id = ? AND status = 'PENDING'`,
      )
      .bind(now, runId),
  );
  const results = await db.batch(statements);
  return (results[results.length - 1]?.meta.changes ?? 0) === 1;
}

export interface QuotaReconciliation {
  committed: number;
  released: number;
}

/**
 * Resolves reservations left PENDING by an interrupted request. A reservation
 * whose run exists is committed; one whose run never materialised is released.
 * Bounded per invocation to stay inside the cron CPU budget.
 */
export async function reconcileQuotaReservations(
  db: D1Database,
  olderThan: string,
  limit = 25,
): Promise<QuotaReconciliation> {
  const pending = await db
    .prepare(
      `SELECT run_id FROM quota_reservations
        WHERE status = 'PENDING' AND created_at < ?
        ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(olderThan, limit)
    .all<{ run_id: string }>();

  let committed = 0;
  let released = 0;
  for (const row of pending.results) {
    const run = await db
      .prepare(`SELECT id FROM runs WHERE id = ?`)
      .bind(row.run_id)
      .first<{ id: string }>();
    if (run !== null) {
      if (await commitQuotaReservation(db, row.run_id)) committed += 1;
      continue;
    }
    if (await releaseQuotaReservation(db, row.run_id)) released += 1;
  }
  return { committed, released };
}

export async function deleteResolvedQuotaReservations(
  db: D1Database,
  before: string,
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM quota_reservations
        WHERE status IN ('COMMITTED', 'RELEASED') AND created_at < ?`,
    )
    .bind(before)
    .run();
  return result.meta.changes;
}

/* ------------------------------------------------------------------------- */
/* Flags and status                                                           */
/* ------------------------------------------------------------------------- */

export async function getFlag(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM system_flags WHERE key = ?`).bind(key).first<{
    value: string;
  }>();
  return row?.value ?? null;
}

export async function setFlag(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO system_flags (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, nowIso())
    .run();
}

export async function getSandboxStatus(
  db: D1Database,
  config: {
    sandbox: {
      dailyRunLimit: number;
      sessionHourlyLimit: number;
      sessionDailyLimit: number;
      globalConcurrencyLimit: number;
    };
    retentionDays: number;
  },
  sessionHash: string,
): Promise<SandboxStatus> {
  const day = new Date().toISOString().slice(0, 10);
  const hour = new Date().toISOString().slice(0, 13);
  const [
    enabledFlag,
    circuitUntil,
    globalRunsToday,
    sessionRunsToday,
    sessionRunsThisHour,
    activeRuns,
  ] = await Promise.all([
    getFlag(db, "sandbox_enabled"),
    getFlag(db, "sandbox_circuit_open_until"),
    getQuotaCount(db, `global:day:${day}`),
    getQuotaCount(db, `session:${sessionHash}:day:${day}`),
    getQuotaCount(db, `session:${sessionHash}:hour:${hour}`),
    countActiveLeases(db, "prj_sandbox"),
  ]);

  const circuitOpenUntil =
    circuitUntil !== null && Date.parse(circuitUntil) > Date.now() ? circuitUntil : null;

  return {
    enabled: enabledFlag !== "false" && circuitOpenUntil === null,
    circuitOpenUntil,
    globalRunsToday,
    globalDailyLimit: config.sandbox.dailyRunLimit,
    activeRuns,
    activeRunLimit: config.sandbox.globalConcurrencyLimit,
    sessionRunsToday,
    sessionDailyLimit: config.sandbox.sessionDailyLimit,
    sessionRunsThisHour,
    sessionHourlyLimit: config.sandbox.sessionHourlyLimit,
    retentionDays: config.retentionDays,
  };
}
