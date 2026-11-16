import { isActiveRunStatus, type RunStatus } from "../../shared/domain/status";

/**
 * Polling policy.
 *
 * Polling is only useful while a run can still change. Every terminal state
 * stops it, visitors who have not loaded data yet are never polled, and React
 * Query's `refetchIntervalInBackground: false` (set at every call site) pauses
 * the interval while the tab is hidden and resumes it on visibility.
 *
 * Keeping the decision in one tested function prevents individual pages from
 * slowly regressing into idle polling.
 */

/** Detail and event pages while a run is active. */
export const ACTIVE_RUN_POLL_MS = 2_000;

/** Overview only while at least one run is queued, running or cancelling. */
export const ACTIVE_OVERVIEW_POLL_MS = 4_000;

/**
 * `undefined` means "no data yet"; polling before the first successful load
 * would duplicate the initial request.
 */
export function runPollInterval(status: RunStatus | undefined): number | false {
  return status !== undefined && isActiveRunStatus(status) ? ACTIVE_RUN_POLL_MS : false;
}

export interface OverviewActivity {
  queued: number;
  running: number;
  cancelling: number;
}

export function overviewPollInterval(totals: OverviewActivity | undefined): number | false {
  if (totals === undefined) return false;
  const active = totals.queued + totals.running + totals.cancelling;
  return active > 0 ? ACTIVE_OVERVIEW_POLL_MS : false;
}
