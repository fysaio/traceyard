import type { RepositoryCheckRunner } from "./managed-runner";
import type { RepositoryRecord } from "../../shared/repository/contracts";
import { runnerConfigSchema } from "../../shared/repository/workspace";
import { randomId, randomToken, sha256Hex } from "../lib/crypto";
import { badRequest, conflict, notFound, serviceUnavailable } from "../api/errors";
import { githubRequest } from "./github";

declare global {
  interface Env {
    MANAGED_REPOSITORY_RUNNERS?: DurableObjectNamespace<RepositoryCheckRunner>;
    MANAGED_CHECK_CONCURRENCY_LIMIT?: string;
  }
}
export function managedChecksAvailable(env: Env) {
  try {
    const origin = new URL(env.PUBLIC_APP_ORIGIN ?? "");
    return (
      !!env.MANAGED_REPOSITORY_RUNNERS &&
      origin.protocol === "https:" &&
      !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash &&
      !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    );
  } catch {
    return false;
  }
}
export async function requestManagedCheck(
  env: Env,
  projectId: string,
  requestKey: string,
  fetcher: typeof fetch = fetch,
  savedRequestId?: string,
  commitRef?: string,
) {
  if (!managedChecksAvailable(env))
    throw serviceUnavailable(
      "CHECK_SERVICE_UNAVAILABLE",
      "Checks are temporarily unavailable. You can still explore the operations discovered in your repository.",
    );
  if (!/^[A-Za-z0-9:_-]{1,140}$/.test(requestKey))
    throw badRequest("REQUEST_ID_REQUIRED", "Use a valid check request ID.");
  const repo = await env.DB.prepare(
    "SELECT r.* FROM project_repositories r JOIN projects p ON p.id=r.project_id JOIN github_installations g ON g.id=r.installation_id JOIN identities i ON i.provider='github' AND i.provider_subject=g.account_id AND i.user_id=p.owner_user_id WHERE r.project_id=? AND g.suspended=0",
  )
    .bind(projectId)
    .first<RepositoryRecord>();
  if (!repo?.installation_id || !repo.repository_id || !repo.default_branch)
    throw notFound("Repository access is unavailable.");
  // Replays refer to the original snapshot even if the default branch moved.
  const old = await env.DB.prepare(
    "SELECT id,request_hash FROM managed_repository_checks WHERE project_id=? AND request_key=?",
  )
    .bind(projectId, requestKey)
    .first<{ id: string; request_hash: string }>();
  const requestHash = await sha256Hex(JSON.stringify({ savedRequestId: savedRequestId ?? null }));
  if (old) {
    if (old.request_hash !== requestHash)
      throw conflict(
        "CHECK_REQUEST_REUSED",
        "This request ID belongs to another check. No new execution was started.",
      );
    return {
      id: old.id,
      url: `/projects/${projectId}/checks/${old.id}`,
      existing: true,
      state: "QUEUED",
    };
  }
  const active = await env.DB.prepare(
    "SELECT id FROM managed_repository_checks WHERE project_id=? AND state IN ('QUEUED','RUNNING') LIMIT 1",
  )
    .bind(projectId)
    .first<{ id: string }>();
  if (active && savedRequestId)
    throw conflict(
      "CHECK_ALREADY_RUNNING",
      "Another check is running. Your saved test remains available; run it when that check ends.",
    );
  if (active && !requestKey.startsWith("push:"))
    return {
      id: active.id,
      url: `/projects/${projectId}/checks/${active.id}`,
      existing: true,
      state: "QUEUED",
    };
  const commit = await githubRequest<{ sha: string }>(
    env,
    repo.installation_id,
    `/repos/${repo.full_name}/commits/${encodeURIComponent(commitRef ?? repo.default_branch)}`,
    {},
    fetcher,
  );
  if (!/^[a-f0-9]{40}$/.test(commit.sha))
    throw badRequest("COMMIT_INVALID", "GitHub did not return a valid commit.");
  const config = await env.DB.prepare(
    "SELECT config_json FROM repository_runner_configs WHERE project_id=?",
  )
    .bind(projectId)
    .first<{ config_json: string }>();
  const saved = savedRequestId
    ? await env.DB.prepare(
        "SELECT snapshot_json FROM repository_check_requests WHERE id=? AND project_id=?",
      )
        .bind(savedRequestId, projectId)
        .first<{ snapshot_json: string }>()
    : null;
  if (savedRequestId && !saved) throw notFound("Saved check request not found.");
  const id = randomId("managed"),
    token = "tyr_" + randomToken(),
    at = new Date().toISOString();
  const snapshot = {
    repositoryId: repo.repository_id,
    installationId: repo.installation_id,
    fullName: repo.full_name,
    sha: commit.sha,
    manifest: saved
      ? JSON.parse(saved.snapshot_json)
      : {
          config: runnerConfigSchema.parse(config ? JSON.parse(config.config_json) : {}),
          cases: [],
        },
  };
  const insertion = env.DB.prepare(
    "INSERT INTO managed_repository_checks(id,project_id,request_key,request_hash,token_hash,expires_at,snapshot_json,created_at) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM managed_repository_checks WHERE project_id=? AND created_at>?)<6 AND (?=1 OR NOT EXISTS(SELECT 1 FROM managed_repository_checks WHERE project_id=? AND state IN ('QUEUED','RUNNING'))) ON CONFLICT(project_id,request_key) DO NOTHING RETURNING id",
  ).bind(
    id,
    projectId,
    requestKey,
    requestHash,
    await sha256Hex(token),
    new Date(Date.now() + 30 * 60000).toISOString(),
    JSON.stringify(snapshot),
    at,
    projectId,
    new Date(Date.now() - 3600000).toISOString(),
    requestKey.startsWith("push:") ? 1 : 0,
    projectId,
  );
  const inserted = await env.DB.batch([
    insertion,
    env.DB.prepare(
      "INSERT INTO repository_jobs(id,project_id,commit_sha,source,phase,status,events_json,updated_at) SELECT id,project_id,?,'managed','checkout','QUEUED',?,? FROM managed_repository_checks WHERE id=? ON CONFLICT DO NOTHING",
    ).bind(
      commit.sha,
      JSON.stringify([
        { phase: "checkout", status: "RUNNING", message: "Waiting for an isolated runner.", at },
      ]),
      at,
      id,
    ),
  ]);
  const created = inserted[0]?.results.length;
  if (!created) {
    const raced = await env.DB.prepare(
      "SELECT id,request_hash FROM managed_repository_checks WHERE project_id=? AND request_key=?",
    )
      .bind(projectId, requestKey)
      .first<{ id: string; request_hash: string }>();
    if (raced && raced.request_hash === requestHash)
      return {
        id: raced.id,
        url: `/projects/${projectId}/checks/${raced.id}`,
        existing: true,
        state: "QUEUED",
      };
    throw conflict(
      "CHECK_LIMIT",
      "This project has reached its hourly check limit. Discovered operations remain available.",
    );
  }
  if (savedRequestId)
    await env.DB.prepare(
      "UPDATE repository_check_requests SET runner_id=? WHERE id=? AND project_id=?",
    )
      .bind(id, savedRequestId, projectId)
      .run();
  try {
    await env.MANAGED_REPOSITORY_RUNNERS!.getByName(id).enqueue({ id, projectId, token });
  } catch {
    await finishManagedCheck(
      env,
      id,
      "FAILED",
      "The execution service could not start this check. Your discovered operations are still available.",
    );
  }
  return { id, url: `/projects/${projectId}/checks/${id}`, existing: false, state: "QUEUED" };
}

export async function finishManagedCheck(env: Env, id: string, status: string, message: string) {
  const row = await env.DB.prepare(
    "SELECT j.project_id,j.status,j.events_json FROM repository_jobs j WHERE j.id=? AND j.source='managed'",
  )
    .bind(id)
    .first<{ project_id: string; status: string; events_json: string }>();
  if (!row) return;
  if (["RUNNING", "QUEUED"].includes(row.status)) {
    const at = new Date().toISOString(),
      events = JSON.parse(row.events_json) as unknown[];
    await env.DB.prepare(
      "UPDATE repository_jobs SET status=?,phase='complete',events_json=?,updated_at=? WHERE project_id=? AND id=? AND status IN ('RUNNING','QUEUED')",
    )
      .bind(
        status,
        JSON.stringify([...events, { phase: "complete", status, message, at }].slice(-30)),
        at,
        row.project_id,
        id,
      )
      .run();
  }
  await env.DB.prepare(
    "UPDATE managed_repository_checks SET state=CASE WHEN (SELECT status FROM repository_jobs WHERE repository_jobs.id=managed_repository_checks.id)='CANCELLED' THEN 'CANCELLED' ELSE 'FINISHED' END WHERE id=?",
  )
    .bind(id)
    .run();
}

export async function reapManagedChecks(env: Env) {
  const old = await env.DB.prepare(
    "SELECT id FROM managed_repository_checks WHERE state IN ('QUEUED','RUNNING') AND expires_at<? LIMIT 10",
  )
    .bind(new Date().toISOString())
    .all<{ id: string }>();
  for (const check of old.results) {
    await finishManagedCheck(
      env,
      check.id,
      "FAILED",
      "The runner stopped reporting and its outcome could not be verified. It was not automatically repeated. Source discoveries remain available.",
    );
    await env.MANAGED_REPOSITORY_RUNNERS?.getByName(check.id)
      .cancel()
      .catch(() => {});
  }
}
