import { dispatchGitHubChecks } from "./github-checks";
import { managedChecksAvailable, requestManagedCheck } from "./managed";
import { randomId } from "../lib/crypto";

// An explicit Run action uses GitHub CI on standard deployments.
export async function dispatchRepositoryChecks(
  env: Env,
  projectId: string,
  fetcher: typeof fetch = fetch,
  savedRequestId?: string,
  requestKey?: string,
) {
  if (!managedChecksAvailable(env))
    return dispatchGitHubChecks(
      env,
      projectId,
      requestKey ?? savedRequestId ?? randomId("manual"),
      fetcher,
      savedRequestId,
    );
  const saved = savedRequestId
    ? await env.DB.prepare(
        "SELECT snapshot_json FROM repository_check_requests WHERE id=? AND project_id=?",
      )
        .bind(savedRequestId, projectId)
        .first<{ snapshot_json: string }>()
    : null;
  const commit = saved ? JSON.parse(saved.snapshot_json).investigation?.commit : undefined;
  return requestManagedCheck(
    env,
    projectId,
    requestKey ?? (savedRequestId ? "case:" + savedRequestId : randomId("manual")),
    fetcher,
    savedRequestId,
    commit,
  );
}
export async function startInitialChecks(
  env: Env,
  projectId: string,
  fetcher: typeof fetch = fetch,
  scanId?: string,
) {
  const repo = await env.DB.prepare(
    "SELECT scan_id,commit_sha,status,runner_enabled FROM project_repositories WHERE project_id=?",
  )
    .bind(projectId)
    .first<{
      scan_id: string | null;
      commit_sha: string | null;
      status: string;
      runner_enabled: number;
    }>();
  if (scanId && repo?.scan_id !== scanId) return { state: "SUPERSEDED" };
  if (!managedChecksAvailable(env)) {
    if (!repo?.runner_enabled) return { state: "SETUP_REQUIRED" };
    // A setup merge can finish discovery after the owner's first manual Run.
    const recent = await env.DB.prepare(
      "SELECT id FROM repository_jobs WHERE project_id=? AND source='github' AND commit_sha=? AND updated_at>? LIMIT 1",
    )
      .bind(projectId, repo.commit_sha, new Date(Date.now() - 15 * 60000).toISOString())
      .first();
    if (recent) return { state: "ALREADY_CHECKED" };
    return dispatchGitHubChecks(
      env,
      projectId,
      "scan:" + (repo?.scan_id ?? randomId("scan")),
      fetcher,
    );
  }
  return requestManagedCheck(
    env,
    projectId,
    (repo?.scan_id?.startsWith("scan_prj_") ? "push:" : "scan:") +
      (repo?.scan_id ?? repo?.commit_sha ?? projectId),
    fetcher,
    undefined,
    repo?.status === "DISCOVERED" ? (repo.commit_sha ?? undefined) : undefined,
  );
}
