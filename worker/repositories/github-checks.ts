import type { RepositoryRecord } from "../../shared/repository/contracts";
import { runnerConfigSchema } from "../../shared/repository/workspace";
import { ApiError, badRequest, conflict, notFound, serviceUnavailable } from "../api/errors";
import { nowIso } from "../lib/time";
import { sha256Hex } from "../lib/crypto";
import { githubConfigured, repositoryGitHubClient } from "./github";
import { DEFAULT_RUNNER_REF, runnerWorkflow } from "./runner-workflow";
const FILE = ".github/workflows/traceyard.yml";
interface Setup {
  branch: string;
  number: number;
  headSha: string;
}
interface Pull {
  number: number;
  html_url: string;
  merged: boolean;
  state: string;
  changed_files: number;
  head: { sha: string; ref: string; repo: { id: number } };
  base: { ref: string; repo: { id: number } };
}
type GitHub = Awaited<ReturnType<typeof repositoryGitHubClient>>;
export function githubChecksAvailable(env: Env) {
  try {
    const u = new URL(env.PUBLIC_APP_ORIGIN ?? "");
    return (
      githubConfigured(env) &&
      u.protocol === "https:" &&
      u.pathname === "/" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      /^[a-f0-9]{40}$/.test(env.TRACEYARD_RUNNER_REF ?? DEFAULT_RUNNER_REF)
    );
  } catch {
    return false;
  }
}
async function connected(env: Env, projectId: string) {
  if (!githubChecksAvailable(env))
    throw serviceUnavailable(
      "GITHUB_CHECKS_UNCONFIGURED",
      "GitHub checks need the server's GitHub App configuration.",
    );
  const r = await env.DB.prepare(
    "SELECT r.* FROM project_repositories r JOIN projects p ON p.id=r.project_id JOIN github_installations g ON g.id=r.installation_id JOIN identities i ON i.provider='github' AND i.provider_subject=g.account_id AND i.user_id=p.owner_user_id WHERE r.project_id=? AND g.suspended=0",
  )
    .bind(projectId)
    .first<RepositoryRecord>();
  if (!r?.repository_id || !r.installation_id || !r.default_branch)
    throw notFound("GitHub repository access is unavailable.");
  return r as RepositoryRecord & {
    repository_id: number;
    installation_id: number;
    default_branch: string;
  };
}
async function optional<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && (e.details as { githubStatus?: number })?.githubStatus === 404)
      return null;
    throw e;
  }
}
const contentFor = (env: Env) =>
  runnerWorkflow(
    new URL(env.PUBLIC_APP_ORIGIN!).origin,
    env.TRACEYARD_RUNNER_REF ?? DEFAULT_RUNNER_REF,
  );
const encoded = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
async function state(env: Env, projectId: string, value: string, error: string | null = null) {
  await env.DB.prepare(
    "UPDATE project_repositories SET check_setup_state=?,check_setup_error=?,check_setup_updated_at=? WHERE project_id=?",
  )
    .bind(value, error, nowIso(), projectId)
    .run();
}
async function ready(env: Env, projectId: string) {
  await env.DB.prepare(
    "UPDATE project_repositories SET runner_enabled=1,check_setup_state='READY',check_setup_error=NULL,check_setup_updated_at=? WHERE project_id=?",
  )
    .bind(nowIso(), projectId)
    .run();
  return { state: "READY" as const };
}
async function checkPull(
  gh: GitHub,
  repo: Awaited<ReturnType<typeof connected>>,
  setup: Setup,
  expected: string,
) {
  const base = `/repos/${repo.full_name}`;
  const pr = await gh<Pull>(`${base}/pulls/${setup.number}`);
  if (
    pr.head.sha !== setup.headSha ||
    pr.head.ref !== setup.branch ||
    pr.head.repo.id !== repo.repository_id ||
    pr.base.repo.id !== repo.repository_id ||
    pr.base.ref !== repo.default_branch ||
    pr.changed_files !== 1
  )
    throw conflict(
      "CI_SETUP_CHANGED",
      "The setup change has changed since it was prepared. Prepare it again before approval.",
    );
  const files = await gh<{ filename: string; status: string; previous_filename?: string }[]>(
    `${base}/pulls/${setup.number}/files?per_page=2`,
  );
  if (
    files.length !== 1 ||
    files[0]?.filename !== FILE ||
    !["added", "modified"].includes(files[0].status) ||
    files[0].previous_filename
  )
    throw conflict(
      "CI_SETUP_CHANGED",
      "Only the Traceyard workflow file may be changed by this approval.",
    );
  const file = await gh<{ content: string }>(`${base}/contents/${FILE}?ref=${setup.headSha}`);
  if (file.content.replace(/\s/g, "") !== encoded(expected))
    throw conflict("CI_SETUP_CHANGED", "The workflow no longer matches the displayed setup.");
  return pr;
}
export async function prepareGitHubChecks(
  env: Env,
  projectId: string,
  fetcher: typeof fetch = fetch,
  approvedPreview?: string,
) {
  const repo = await connected(env, projectId),
    gh = await repositoryGitHubClient(env, repo.installation_id, repo.repository_id, fetcher);
  const path = `/repos/${repo.full_name}`,
    workflow = contentFor(env);
  const { sha: baseSha } = await gh<{ sha: string }>(
    `${path}/commits/${encodeURIComponent(repo.default_branch)}`,
  );
  const existing = await optional(
    gh<{ content: string; sha: string }>(`${path}/contents/${FILE}?ref=${baseSha}`),
  );
  if (existing?.content.replace(/\s/g, "") === encoded(workflow))
    return repo.runner_enabled ? { state: "READY" as const } : ready(env, projectId);

  const workflowHash = await sha256Hex(workflow);
  const branchPrefix = `traceyard/checks-${projectId}-${workflowHash.slice(0, 10)}`;
  const setup = repo.ci_setup_json ? (JSON.parse(repo.ci_setup_json) as Setup) : null;
  if (
    setup?.number &&
    (setup.branch === branchPrefix || setup.branch.startsWith(branchPrefix + "-"))
  ) {
    const pr = await checkPull(gh, repo, setup, workflow);
    if (pr.state === "open") {
      return {
        state: "AWAITING_MERGE" as const,
        prUrl: pr.html_url,
        prNumber: setup.number,
        headSha: setup.headSha,
      };
    }
  }
  const preview = {
    state: "SETUP_REQUIRED" as const,
    previousWorkflow: existing
      ? new TextDecoder().decode(Uint8Array.from(atob(existing.content), (c) => c.charCodeAt(0)))
      : null,
    workflow,
    defaultBranch: repo.default_branch,
    previewKey: await sha256Hex(
      JSON.stringify([
        repo.repository_id,
        repo.default_branch,
        baseSha,
        existing?.sha,
        workflowHash,
      ]),
    ),
  };
  if (!approvedPreview) return preview;
  if (approvedPreview !== preview.previewKey)
    throw conflict(
      "CI_PREVIEW_STALE",
      "The default branch or workflow changed. Refresh the preview before creating the pull request.",
    );

  const at = nowIso();
  const claim = await env.DB.prepare(
    "UPDATE project_repositories SET check_setup_state='PREPARING',check_setup_error=NULL,check_setup_updated_at=? WHERE project_id=? AND (check_setup_state!='PREPARING' OR check_setup_updated_at<?) RETURNING project_id",
  )
    .bind(at, projectId, new Date(Date.now() - 120000).toISOString())
    .first();
  if (!claim) return { state: "PREPARING" as const };
  try {
    const branch = `${branchPrefix}-${baseSha.slice(0, 10)}`;
    const branchRef = await optional(
      gh<{ object: { sha: string } }>(`${path}/git/ref/heads/${branch}`),
    );
    if (!branchRef) {
      await gh(`${path}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: "refs/heads/" + branch, sha: baseSha }),
      });
    }
    const file = await optional(
      gh<{ content: string; sha: string }>(
        `${path}/contents/${FILE}?ref=${encodeURIComponent(branch)}`,
      ),
    );
    let approvedHead = branchRef?.object.sha;
    if (file?.content.replace(/\s/g, "") !== encoded(workflow)) {
      if (branchRef && file?.content.replace(/\s/g, "") !== existing?.content.replace(/\s/g, ""))
        throw conflict(
          "CI_SETUP_CHANGED",
          "The setup branch contains an unexpected workflow change.",
        );
      const updated = await gh<{ commit: { sha: string } }>(`${path}/contents/${FILE}`, {
        method: "PUT",
        body: JSON.stringify({
          message: "Enable Traceyard checks",
          branch,
          content: encoded(workflow),
          ...(file ? { sha: file.sha } : {}),
        }),
      });
      approvedHead = updated.commit.sha;
    }
    if (!approvedHead)
      throw conflict(
        "CI_SETUP_CHANGED",
        "The setup branch changed during preparation. Refresh the preview.",
      );
    const difference = await gh<{
      files?: { filename: string; status: string; previous_filename?: string }[];
    }>(`${path}/compare/${baseSha}...${approvedHead}`);
    const changed = difference.files?.[0];
    if (
      difference.files?.length !== 1 ||
      changed?.filename !== FILE ||
      !["added", "modified"].includes(changed.status) ||
      changed.previous_filename
    )
      throw conflict(
        "CI_SETUP_CHANGED",
        "The setup branch contains changes outside the reviewed workflow.",
      );

    const prs = await gh<Pull[]>(
      `${path}/pulls?state=open&head=${encodeURIComponent(repo.full_name.split("/")[0] + ":" + branch)}&base=${encodeURIComponent(repo.default_branch)}`,
    );
    const pr =
      prs[0] ??
      (await gh<Pull>(`${path}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: "Enable Traceyard checks",
          head: branch,
          base: repo.default_branch,
          body: "Adds or updates only the Traceyard CI workflow. Review and merge this pull request on GitHub. Runs on your GitHub Actions allowance with a 10-minute job limit. Uses GitHub OIDC; no Traceyard API key or application credentials are added. Application source remains unchanged.",
        }),
      }));
    const saved: Setup = { branch, number: pr.number, headSha: approvedHead };
    await checkPull(gh, repo, saved, workflow);
    await env.DB.prepare(
      "UPDATE project_repositories SET ci_setup_json=?,setup_pr_url=?,runner_enabled=0,check_setup_state='AWAITING_MERGE',check_setup_error=NULL,check_setup_updated_at=? WHERE project_id=?",
    )
      .bind(JSON.stringify(saved), pr.html_url, nowIso(), projectId)
      .run();
    return {
      state: "AWAITING_MERGE" as const,
      prUrl: pr.html_url,
      prNumber: pr.number,
      headSha: pr.head.sha,
    };
  } catch (e) {
    await state(
      env,
      projectId,
      "FAILED",
      e instanceof ApiError ? e.message : "Setup could not be prepared. Retry inside Traceyard.",
    );
    throw e;
  }
}
export async function dispatchGitHubChecks(
  env: Env,
  projectId: string,
  requestKey: string,
  fetcher: typeof fetch = fetch,
  savedRequestId?: string,
) {
  if (!/^[A-Za-z0-9:_-]{1,140}$/.test(requestKey))
    throw badRequest("REQUEST_ID_REQUIRED", "Provide a valid check request ID.");
  const repo = await connected(env, projectId);
  const id = "ci_" + (await sha256Hex(projectId + ":" + requestKey)).slice(0, 32);
  const requestHash = await sha256Hex(JSON.stringify({ savedRequestId: savedRequestId ?? null }));
  const previous = await env.DB.prepare(
    "SELECT id,request_hash,state FROM github_check_dispatches WHERE project_id=? AND request_key=?",
  )
    .bind(projectId, requestKey)
    .first<{ id: string; request_hash: string; state: string }>();
  const result = (state: string) => ({ id, url: `/projects/${projectId}/checks/${id}`, state });
  if (previous) {
    if (previous.request_hash !== requestHash)
      throw conflict("CHECK_REQUEST_REUSED", "This request ID belongs to another check.");
    return result(previous.state);
  }
  if (!repo.runner_enabled)
    throw conflict(
      "CI_SETUP_REQUIRED",
      "Hosted tests need setup. Review the workflow change, create the setup PR, then merge it on GitHub.",
    );
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM github_check_dispatches WHERE project_id=? AND created_at>?",
  )
    .bind(projectId, new Date(Date.now() - 3600000).toISOString())
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= 6)
    throw conflict(
      "CHECK_RATE_LIMIT",
      "This project has reached six check requests this hour. Your source discoveries remain available.",
    );
  const active = await env.DB.prepare(
    "SELECT id FROM repository_jobs WHERE project_id=? AND source IN ('github','github-pending') AND status IN ('QUEUED','RUNNING') AND updated_at>? LIMIT 1",
  )
    .bind(projectId, new Date(Date.now() - 15 * 60000).toISOString())
    .first();
  if (active)
    throw conflict(
      "CHECK_ALREADY_RUNNING",
      "A GitHub check is already queued or running. Follow it before requesting another.",
    );
  const gh = await repositoryGitHubClient(env, repo.installation_id, repo.repository_id, fetcher),
    path = `/repos/${repo.full_name}`;
  const file = await optional(
    gh<{ content: string }>(
      `${path}/contents/${FILE}?ref=${encodeURIComponent(repo.default_branch)}`,
    ),
  );
  if (file?.content.replace(/\s/g, "") !== encoded(contentFor(env))) {
    await env.DB.prepare("UPDATE project_repositories SET runner_enabled=0 WHERE project_id=?")
      .bind(projectId)
      .run();
    throw conflict(
      "CI_SETUP_REQUIRED",
      "The GitHub workflow needs an update. Review the change, create the setup PR, then merge it on GitHub.",
    );
  }
  const config = await env.DB.prepare(
    "SELECT config_json FROM repository_runner_configs WHERE project_id=?",
  )
    .bind(projectId)
    .first<{ config_json: string }>();
  const saved = savedRequestId
    ? await env.DB.prepare(
        "SELECT snapshot_json FROM repository_check_requests WHERE id=? AND project_id=? AND runner_id IS NULL AND NOT EXISTS(SELECT 1 FROM github_check_dispatches WHERE snapshot_request_id=repository_check_requests.id)",
      )
        .bind(savedRequestId, projectId)
        .first<{ snapshot_json: string }>()
    : null;
  if (savedRequestId && !saved) throw notFound("Saved check request not found.");
  const snapshotId = savedRequestId ?? id;
  const snapshot =
    saved?.snapshot_json ??
    JSON.stringify({
      config: runnerConfigSchema.parse(config ? JSON.parse(config.config_json) : {}),
      cases: [],
    });
  const at = nowIso();
  // D1 batch is a single transaction: competing Run requests cannot both claim this project.
  const recent = new Date(Date.now() - 15 * 60000).toISOString();
  const claimed = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO github_check_dispatches(id,project_id,request_key,request_hash,snapshot_request_id,state,created_at,updated_at) SELECT ?,?,?,?,?,'DISPATCHING',?,? WHERE NOT EXISTS(SELECT 1 FROM repository_jobs WHERE project_id=? AND source IN ('github','github-pending') AND status IN ('QUEUED','RUNNING') AND updated_at>?) AND NOT EXISTS(SELECT 1 FROM github_check_dispatches WHERE project_id=? AND state IN ('DISPATCHING','QUEUED','UNKNOWN') AND created_at>?) ON CONFLICT DO NOTHING",
    ).bind(
      id,
      projectId,
      requestKey,
      requestHash,
      snapshotId,
      at,
      at,
      projectId,
      recent,
      projectId,
      recent,
    ),
    env.DB.prepare(
      "INSERT INTO repository_check_requests(id,project_id,snapshot_json,created_at) SELECT ?,?,?,? FROM github_check_dispatches WHERE id=? AND state='DISPATCHING' ON CONFLICT DO NOTHING",
    ).bind(snapshotId, projectId, snapshot, at, id),
    env.DB.prepare(
      "INSERT INTO repository_jobs(id,project_id,source,phase,status,events_json,updated_at) SELECT ?,?,'github-pending','dispatch','QUEUED',?,? FROM github_check_dispatches WHERE id=? AND state='DISPATCHING' ON CONFLICT DO NOTHING",
    ).bind(
      id,
      projectId,
      JSON.stringify([
        {
          phase: "dispatch",
          status: "RUNNING",
          message: "Requesting a GitHub runner. Progress will appear here.",
          at,
        },
      ]),
      at,
      id,
    ),
    env.DB.prepare(
      "UPDATE project_repositories SET check_setup_state='QUEUED',last_dispatch_at=?,check_setup_updated_at=? WHERE project_id=? AND EXISTS(SELECT 1 FROM github_check_dispatches WHERE id=? AND state='DISPATCHING')",
    ).bind(at, at, projectId, id),
  ]);
  if (!claimed[0]?.meta.changes) {
    const replay = await env.DB.prepare(
      "SELECT state,request_hash FROM github_check_dispatches WHERE id=?",
    )
      .bind(id)
      .first<{ state: string; request_hash: string }>();
    if (replay?.request_hash === requestHash) return result(replay.state);
    throw conflict(
      "CHECK_ALREADY_RUNNING",
      "A GitHub check is already queued or running. Follow it before requesting another.",
    );
  }
  try {
    await gh(`${path}/actions/workflows/traceyard.yml/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: repo.default_branch, inputs: { run_request: snapshotId } }),
    });
    await env.DB.prepare(
      "UPDATE github_check_dispatches SET state='QUEUED',updated_at=? WHERE id=? AND state='DISPATCHING'",
    )
      .bind(nowIso(), id)
      .run();
    return result("QUEUED");
  } catch {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE github_check_dispatches SET state='UNKNOWN',updated_at=? WHERE id=?",
      ).bind(nowIso(), id),
      env.DB.prepare(
        "UPDATE repository_jobs SET status='STALE',events_json=?,updated_at=? WHERE id=? AND project_id=?",
      ).bind(
        JSON.stringify([
          {
            phase: "dispatch",
            status: "STALE",
            message:
              "GitHub did not confirm the request. Traceyard will not repeat it automatically. Refresh this check to look for a matching run.",
            at: nowIso(),
          },
        ]),
        nowIso(),
        id,
        projectId,
      ),
    ]);
    return result("UNKNOWN");
  }
}
export async function bindGitHubDispatch(
  env: Env,
  projectId: string,
  requestId: string,
  runnerId: string,
  sha: string,
) {
  const d = await env.DB.prepare(
    "SELECT id,state FROM github_check_dispatches WHERE project_id=? AND snapshot_request_id=?",
  )
    .bind(projectId, requestId)
    .first<{ id: string; state: string }>();
  if (!d) return; // Legacy and local clients keep their existing snapshot binding.
  if (d.state === "CANCELLED")
    throw conflict("CHECK_CANCELLED", "This check was cancelled before its runner started.");
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE github_check_dispatches SET runner_id=?,state='BOUND',updated_at=? WHERE id=? AND state!='CANCELLED' AND (runner_id IS NULL OR runner_id=?)",
    ).bind(runnerId, at, d.id, runnerId),
    env.DB.prepare(
      "INSERT INTO repository_jobs(id,project_id,commit_sha,source,phase,status,events_json,github_url,updated_at) SELECT ?,project_id,?,'github','discovery','RUNNING',?,NULL,? FROM github_check_dispatches WHERE id=? AND runner_id=? ON CONFLICT(project_id,id) DO NOTHING",
    ).bind(
      runnerId,
      sha,
      JSON.stringify([
        { phase: "dispatch", status: "SUCCEEDED", message: "GitHub runner connected.", at },
      ]),
      at,
      d.id,
      runnerId,
    ),
    env.DB.prepare(
      "DELETE FROM repository_jobs WHERE id=? AND project_id=? AND EXISTS(SELECT 1 FROM repository_jobs WHERE id=? AND project_id=?)",
    ).bind(d.id, projectId, runnerId, projectId),
  ]);
}
export async function syncGitHubDispatches(
  env: Env,
  projectId: string,
  fetcher: typeof fetch = fetch,
) {
  const rows = await env.DB.prepare(
    "SELECT * FROM github_check_dispatches WHERE project_id=? AND state IN ('DISPATCHING','QUEUED','UNKNOWN') AND updated_at<? LIMIT 2",
  )
    .bind(projectId, new Date(Date.now() - 60000).toISOString())
    .all<{ id: string; snapshot_request_id: string; created_at: string; updated_at: string }>();
  if (!rows.results.length) return;
  let repo: Awaited<ReturnType<typeof connected>>, gh: GitHub;
  try {
    repo = await connected(env, projectId);
    gh = await repositoryGitHubClient(env, repo.installation_id, repo.repository_id, fetcher);
  } catch {
    return;
  } // Runner recovery cannot make the source catalog unavailable.
  for (const row of rows.results) {
    const claim = await env.DB.prepare(
      "UPDATE github_check_dispatches SET updated_at=? WHERE id=? AND updated_at=? RETURNING id",
    )
      .bind(nowIso(), row.id, row.updated_at)
      .first();
    if (!claim) continue;
    try {
      const list = await gh<{
        workflow_runs: {
          id: number;
          run_attempt: number;
          display_title: string;
          head_sha: string;
          head_branch: string;
          path: string;
          repository: { id: number };
        }[];
      }>(
        `/repos/${repo.full_name}/actions/workflows/traceyard.yml/runs?event=workflow_dispatch&per_page=30`,
      );
      const run = list.workflow_runs.find(
        (r) =>
          r.display_title === `Traceyard ${row.snapshot_request_id}` &&
          r.head_branch === repo.default_branch &&
          r.path === FILE &&
          r.repository.id === repo.repository_id,
      );
      if (run) {
        const bound = await env.DB.prepare(
          "UPDATE repository_check_requests SET runner_id=? WHERE id=? AND project_id=? AND (runner_id IS NULL OR runner_id=?)",
        )
          .bind(
            `${run.id}-${run.run_attempt}`,
            row.snapshot_request_id,
            projectId,
            `${run.id}-${run.run_attempt}`,
          )
          .run();
        if (!bound.meta.changes) continue;
        await bindGitHubDispatch(
          env,
          projectId,
          row.snapshot_request_id,
          `${run.id}-${run.run_attempt}`,
          run.head_sha,
        );
      } else if (Date.now() - Date.parse(row.created_at) > 10 * 60000) {
        await env.DB.batch([
          env.DB.prepare("UPDATE github_check_dispatches SET state='UNCONFIRMED' WHERE id=?").bind(
            row.id,
          ),
          env.DB.prepare(
            "UPDATE repository_jobs SET status='STALE',events_json=?,updated_at=? WHERE id=? AND project_id=?",
          ).bind(
            JSON.stringify([
              {
                phase: "dispatch",
                status: "STALE",
                message:
                  "No matching GitHub runner was confirmed within ten minutes. No automatic retry was made.",
                at: nowIso(),
              },
            ]),
            nowIso(),
            row.id,
            projectId,
          ),
        ]);
      }
    } catch {
      /* Keep an uncertain outcome; never auto-dispatch a second job. */
    }
  }
}
