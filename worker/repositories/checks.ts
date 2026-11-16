import { requestManagedCheck } from "./managed";
import { randomId } from "../lib/crypto";

// Repository execution belongs to Traceyard. Connecting never writes customer
// workflow files, opens setup PRs, or dispatches their GitHub Actions.
export async function dispatchRepositoryChecks(
  env: Env,
  projectId: string,
  fetcher: typeof fetch = fetch,
  savedRequestId?: string,
  requestKey?: string,
) {
  return requestManagedCheck(
    env,
    projectId,
    requestKey ?? (savedRequestId ? "case:" + savedRequestId : randomId("manual")),
    fetcher,
    savedRequestId,
  );
}
export async function startInitialChecks(
  env: Env,
  projectId: string,
  fetcher: typeof fetch = fetch,
  scanId?: string,
) {
  const repo = await env.DB.prepare(
    "SELECT scan_id,commit_sha,status FROM project_repositories WHERE project_id=?",
  )
    .bind(projectId)
    .first<{ scan_id: string | null; commit_sha: string | null; status: string }>();
  if (scanId && repo?.scan_id !== scanId) return { state: "SUPERSEDED" };
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
