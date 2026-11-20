import { maintainInvestigations } from "../services/investigation-maintenance";
import { reapManagedChecks } from "../repositories/managed";
import { isoFromNow, nowIso } from "../lib/time";
import { log } from "../observability/logger";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Scheduled maintenance. Runs every five minutes and performs only bounded work
 * per invocation so it stays within free-tier limits.
 */
export async function runScheduledJobs(env: Env): Promise<void> {
  await reapManagedChecks(env);
  await maintainInvestigations(env.DB);
  const now = nowIso();
  const monthAgo = isoFromNow(-30 * DAY_MS);
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM managed_repository_checks WHERE state IN ('FINISHED','CANCELLED') AND created_at<?",
    ).bind(monthAgo),
    env.DB.prepare("DELETE FROM github_check_dispatches WHERE created_at<?").bind(monthAgo),
    env.DB.prepare("DELETE FROM repository_check_requests WHERE created_at<?").bind(monthAgo),
    env.DB.prepare("DELETE FROM repository_test_results WHERE created_at<?").bind(monthAgo),
    env.DB.prepare("DELETE FROM github_webhook_deliveries WHERE received_at<?").bind(monthAgo),
    env.DB.prepare("DELETE FROM repository_jobs WHERE updated_at<?").bind(monthAgo),
    env.DB.prepare("DELETE FROM user_sessions WHERE expires_at<? OR revoked_at<?").bind(
      now,
      isoFromNow(-90 * DAY_MS),
    ),
    env.DB.prepare("DELETE FROM github_oauth_states WHERE expires_at<?").bind(now),
    // Anonymous browser sessions inactive for 30 days are obsolete.
    env.DB.prepare("DELETE FROM sandbox_sessions WHERE last_seen_at<?").bind(monthAgo),
  ]);
  log("info", "scheduled.maintenance", {});
}
