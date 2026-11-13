import type {
  AnalyticsPayload,
  OverviewPayload,
  StepDurationStats,
  TrendPoint,
} from "../../shared/contracts/api";
import { DOCUMENT_WORKFLOW } from "../../shared/workflow/document";
import type { AppConfig } from "../config";
import { daysAgoIso } from "../lib/time";
import {
  durationStats,
  getFailureClasses,
  getRunTimings,
  getStatusTotals,
  getStepTimings,
  getTrend,
  timingDifference,
} from "../persistence/metrics";
import { getSandboxStatus } from "../persistence/quotas";
import { emptyStepCounts, toRunSummary } from "../persistence/mappers";
import { getStepStatusCounts, listRuns } from "../persistence/runs";
import { SANDBOX_PROJECT_ID } from "../persistence/catalog";
import type { RunStatus } from "../../shared/domain/status";

interface TotalCounts {
  runs: number;
  succeeded: number;
  failed: number;
  running: number;
  queued: number;
  cancelling: number;
  cancelled: number;
  successRate: number | null;
}

function foldStatusTotals(rows: Array<{ status: string; count: number }>): TotalCounts {
  const byStatus = new Map<string, number>();
  for (const row of rows) {
    byStatus.set(row.status, Number(row.count));
  }
  const succeeded = byStatus.get("SUCCEEDED") ?? 0;
  const failed = byStatus.get("FAILED") ?? 0;
  const terminal = succeeded + failed;
  return {
    runs: rows.reduce((sum, row) => sum + Number(row.count), 0),
    succeeded,
    failed,
    running: byStatus.get("RUNNING") ?? 0,
    queued: byStatus.get("QUEUED") ?? 0,
    cancelling: byStatus.get("CANCELLING") ?? 0,
    cancelled: byStatus.get("CANCELLED") ?? 0,
    successRate: terminal === 0 ? null : Math.round((succeeded / terminal) * 10_000) / 100,
  };
}

function foldWindow(trend: TrendPoint[]): { runs: number; succeeded: number; failed: number } {
  return trend.reduce(
    (accumulator, point) => ({
      runs: accumulator.runs + point.total,
      succeeded: accumulator.succeeded + point.succeeded,
      failed: accumulator.failed + point.failed,
    }),
    { runs: 0, succeeded: 0, failed: 0 },
  );
}

function stepDurationStats(
  rows: Array<{ step_key: string; name: string; started_at: string; completed_at: string }>,
): StepDurationStats[] {
  const order = new Map<string, number>(
    DOCUMENT_WORKFLOW.steps.map((step) => [step.key as string, step.ordinal]),
  );
  const grouped = new Map<string, { name: string; durations: number[] }>();
  for (const row of rows) {
    const duration = Date.parse(row.completed_at) - Date.parse(row.started_at);
    if (!Number.isFinite(duration) || duration < 0) continue;
    const entry = grouped.get(row.step_key) ?? { name: row.name, durations: [] };
    entry.durations.push(duration);
    grouped.set(row.step_key, entry);
  }
  return [...grouped.entries()]
    .map(([stepKey, entry]) => {
      const stats = durationStats(entry.durations);
      return {
        stepKey,
        name: entry.name,
        sampleSize: stats.sampleSize,
        p50Ms: stats.p50Ms,
        p95Ms: stats.p95Ms,
      };
    })
    .sort(
      (left, right) =>
        (order.get(left.stepKey) ?? 99) - (order.get(right.stepKey) ?? 99) ||
        left.stepKey.localeCompare(right.stepKey),
    );
}

export async function buildOverview(
  db: D1Database,
  config: AppConfig,
  sessionHash: string,
  days: number,
): Promise<OverviewPayload> {
  const since = daysAgoIso(days - 1);
  const [statusRows, trend, failureClasses, recentRows, timings, sandbox] = await Promise.all([
    getStatusTotals(db, sessionHash),
    getTrend(db, sessionHash, days),
    getFailureClasses(db, sessionHash, since),
    listRuns(db, {
      projectId: SANDBOX_PROJECT_ID,
      sessionHash,
      cursor: null,
      limit: 6,
    }),
    getRunTimings(db, sessionHash, 500),
    getSandboxStatus(db, config, sessionHash),
  ]);

  const counts = await getStepStatusCounts(
    db,
    recentRows.map((row) => row.id),
  );
  const countsByRun = new Map<string, ReturnType<typeof emptyStepCounts>>();
  for (const row of counts) {
    const countsForRun = countsByRun.get(row.run_id) ?? emptyStepCounts();
    const amount = Number(row.count);
    countsForRun.total += amount;
    if (row.status === "PENDING") countsForRun.pending += amount;
    else if (row.status === "RUNNING") countsForRun.running += amount;
    else if (row.status === "SUCCEEDED") countsForRun.succeeded += amount;
    else if (row.status === "FAILED") countsForRun.failed += amount;
    else if (row.status === "SKIPPED") countsForRun.skipped += amount;
    else if (row.status === "CANCELLED") countsForRun.cancelled += amount;
    countsByRun.set(row.run_id, countsForRun);
  }

  const timing = timingDifference(timings);

  return {
    generatedAt: new Date().toISOString(),
    totals: foldStatusTotals(statusRows),
    window: { days, ...foldWindow(trend) },
    trend,
    failureClasses,
    recentRuns: recentRows.map((row) =>
      toRunSummary(row, countsByRun.get(row.id) ?? emptyStepCounts()),
    ),
    executionDuration: durationStats(timing.durations),
    queueDelay: durationStats(timing.queueDelays),
    sandbox,
  };
}

export async function buildAnalytics(
  db: D1Database,
  config: AppConfig,
  sessionHash: string,
  days: number,
): Promise<AnalyticsPayload> {
  const since = daysAgoIso(days - 1);
  const [statusRows, trend, failureClasses, timings, stepTimings, sandbox] = await Promise.all([
    getStatusTotals(db, sessionHash),
    getTrend(db, sessionHash, days),
    getFailureClasses(db, sessionHash, since),
    getRunTimings(db, sessionHash, 1_000),
    getStepTimings(db, sessionHash, 2_000),
    getSandboxStatus(db, config, sessionHash),
  ]);

  const timing = timingDifference(timings);
  const window = foldWindow(trend);

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    trend,
    totals: foldStatusTotals(statusRows),
    failureClasses,
    executionDuration: durationStats(timing.durations),
    queueDelay: durationStats(timing.queueDelays),
    stepDurations: stepDurationStats(stepTimings),
    throughputPerDay: days > 0 ? Math.round((window.runs / days) * 100) / 100 : null,
    sandbox,
  };
}

export function statusLabel(status: RunStatus): string {
  switch (status) {
    case "QUEUED":
      return "Queued";
    case "RUNNING":
      return "Running";
    case "SUCCEEDED":
      return "Succeeded";
    case "FAILED":
      return "Failed";
    case "CANCELLING":
      return "Cancelling";
    case "CANCELLED":
      return "Cancelled";
  }
}
