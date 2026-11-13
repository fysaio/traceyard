import { nowIso } from "../lib/time";
import type { SandboxStatus } from "../../shared/contracts/api";
import { countActiveRuns } from "./runs";

/**
 * Quota counters are shared server-side state. Each bucket key embeds its
 * window (for example `session:<hash>:hour:2026-11-13T09`), so a new window
 * creates a new row rather than requiring a read-modify-write reset.
 */
export async function reserveQuota(
  db: D1Database,
  options: {
    bucketKey: string;
    limit: number;
    windowStart: string;
    expiresAt: string;
  },
): Promise<{ allowed: boolean; count: number }> {
  const now = nowIso();
  const row = await db
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
    .bind(options.bucketKey, options.limit, options.windowStart, options.expiresAt, now)
    .first<{ count: number }>();

  if (row === null) {
    const current = await getQuotaCount(db, options.bucketKey);
    return { allowed: false, count: current };
  }
  return { allowed: true, count: Number(row.count) };
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

export async function getFlag(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM system_flags WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
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
    countActiveRuns(db, "prj_sandbox"),
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
