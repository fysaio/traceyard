import type { RepositoryRecord } from "../../shared/repository/contracts";
import { ApiError, badRequest, conflict, notFound } from "../api/errors";
import { nowIso } from "../lib/time";
import { githubRequest } from "./github";
import { runnerWorkflow } from "./runner-workflow";

async function connectedRepository(env: Env, projectId: string) {
  const repo = await env.DB.prepare(
    "SELECT r.* FROM project_repositories r JOIN projects p ON p.id=r.project_id JOIN github_installations g ON g.id=r.installation_id JOIN identities i ON i.provider='github' AND i.provider_subject=g.account_id AND i.user_id=p.owner_user_id WHERE r.project_id=? AND g.suspended=0",
  )
    .bind(projectId)
    .first<RepositoryRecord>();
  if (!repo?.installation_id || !repo.default_branch)
    throw notFound("GitHub repository access is unavailable.");
  return repo as RepositoryRecord & { installation_id: number; default_branch: string };
}
async function optional<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.details as { githubStatus?: number })?.githubStatus === 404
    )
      return null;
    throw error;
  }
}
export async function dispatchRepositoryChecks(
  env: Env,
  projectId: string,
  fetcher: typeof fetch = fetch,
  requestId?: string,
) {
  const repo = await connectedRepository(env, projectId);
  if (!repo.runner_enabled)
    throw conflict(
      "CHECKS_NOT_READY",
      "Merge the setup PR and wait for the first GitHub check to start.",
    );
  const at = nowIso();
  // A durable lease closes the double-click/concurrent-request gap before GitHub dispatches.
  const claimed = await env.DB.prepare(
    "UPDATE project_repositories SET last_dispatch_at=?,check_setup_state='QUEUED',check_setup_error=NULL,check_setup_updated_at=? WHERE project_id=? AND (last_dispatch_at IS NULL OR last_dispatch_at<?) AND (check_setup_state!='QUEUED' OR check_setup_updated_at<?) AND NOT EXISTS (SELECT 1 FROM repository_jobs WHERE project_id=? AND source='github' AND status='RUNNING' AND updated_at>?) RETURNING project_id",
  )
    .bind(
      at,
      at,
      projectId,
      new Date(Date.now() - 60000).toISOString(),
      new Date(Date.now() - 10 * 60000).toISOString(),
      projectId,
      new Date(Date.now() - 15 * 60000).toISOString(),
    )
    .first();
  if (!claimed)
    throw conflict(
      "CHECK_ALREADY_REQUESTED",
      "A check is running or was just requested. Follow its progress before starting another.",
    );
  try {
    await githubRequest(
      env,
      repo.installation_id,
      `/repos/${repo.full_name}/actions/workflows/traceyard.yml/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({
          ref: repo.default_branch,
          ...(requestId ? { inputs: { run_request: requestId } } : {}),
        }),
      },
      fetcher,
    );
  } catch (error) {
    await env.DB.prepare(
      "UPDATE project_repositories SET last_dispatch_at=NULL,check_setup_state='FAILED',check_setup_error='GitHub could not start the check. Retry after checking Actions access.' WHERE project_id=? AND last_dispatch_at=?",
    )
      .bind(projectId, at)
      .run();
    throw error;
  }
  return {
    url: `https://github.com/${repo.full_name}/actions/workflows/traceyard.yml`,
    state: "QUEUED",
  };
}

export async function prepareRepositoryChecks(
  env: Env,
  projectId: string,
  fetcher: typeof fetch = fetch,
) {
  const repo = await connectedRepository(env, projectId);
  if (repo.runner_enabled)
    return {
      state: "READY",
      url: `https://github.com/${repo.full_name}/actions/workflows/traceyard.yml`,
    };
  if (repo.setup_pr_url) return { state: "AWAITING_MERGE", url: repo.setup_pr_url };
  const at = nowIso();
  const claimed = await env.DB.prepare(
    "UPDATE project_repositories SET check_setup_state='PREPARING',check_setup_error=NULL,check_setup_updated_at=? WHERE project_id=? AND (check_setup_state!='PREPARING' OR check_setup_updated_at<?) RETURNING project_id",
  )
    .bind(at, projectId, new Date(Date.now() - 5 * 60000).toISOString())
    .first();
  if (!claimed) return { state: "PREPARING" };
  try {
    const origin = new URL(env.PUBLIC_APP_ORIGIN ?? "http://localhost");
    if (
      origin.protocol !== "https:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    )
      throw badRequest(
        "PUBLIC_ORIGIN_REQUIRED",
        "GitHub checks need a public HTTPS Traceyard deployment.",
      );
    if (!/^[a-f0-9]{40}$/.test(env.TRACEYARD_RUNNER_REF ?? ""))
      throw badRequest(
        "RUNNER_REF_REQUIRED",
        "Configure the immutable Traceyard runner commit first.",
      );
    const path = `/repos/${repo.full_name}`;
    const branch = "traceyard/setup-" + projectId.replace(/[^A-Za-z0-9_-]/g, "");
    // Stable branch + read-before-write make retries resume a partial installation.
    if (
      !(await optional(
        githubRequest(env, repo.installation_id, `${path}/git/ref/heads/${branch}`, {}, fetcher),
      ))
    ) {
      const commit = await githubRequest<{ sha: string }>(
        env,
        repo.installation_id,
        `${path}/commits/${encodeURIComponent(repo.default_branch)}`,
        {},
        fetcher,
      );
      await githubRequest(
        env,
        repo.installation_id,
        `${path}/git/refs`,
        { method: "POST", body: JSON.stringify({ ref: "refs/heads/" + branch, sha: commit.sha }) },
        fetcher,
      );
    }
    const workflow = runnerWorkflow(origin.origin, repo.default_branch, env.TRACEYARD_RUNNER_REF!);
    const content = btoa(String.fromCharCode(...new TextEncoder().encode(workflow)));
    const file = `${path}/contents/.github/workflows/traceyard.yml`;
    const existing = await optional(
      githubRequest<{ content: string }>(
        env,
        repo.installation_id,
        file + "?ref=" + encodeURIComponent(branch),
        {},
        fetcher,
      ),
    );
    if (existing && existing.content.replace(/\s/g, "") !== content)
      throw conflict(
        "WORKFLOW_EXISTS",
        "A different Traceyard workflow already exists. Review it on GitHub; Traceyard will not overwrite it.",
      );
    if (!existing)
      await githubRequest(
        env,
        repo.installation_id,
        file,
        {
          method: "PUT",
          body: JSON.stringify({ message: "Install Traceyard project checks", branch, content }),
        },
        fetcher,
      );
    const prs = await githubRequest<{ html_url: string }[]>(
      env,
      repo.installation_id,
      `${path}/pulls?state=open&head=${encodeURIComponent(repo.full_name.split("/")[0] + ":" + branch)}`,
      {},
      fetcher,
    );
    const pr =
      prs[0] ??
      (await githubRequest<{ html_url: string }>(
        env,
        repo.installation_id,
        `${path}/pulls`,
        {
          method: "POST",
          body: JSON.stringify({
            title: "Connect Traceyard discovery and project checks",
            head: branch,
            base: repo.default_branch,
            body: "Adds an immutable Node/npm runner. Merging this PR starts the first source scan, build and existing tests with supported automatic Node recording. Later checks run on request (or changes to this workflow), not every application push. One GitHub-hosted Ubuntu job, 10-minute maximum, 180 seconds per application command; concurrent runs are cancelled. Uses the repository owner's GitHub Actions allowance/billing. No Traceyard API key, provider credentials or application secrets are added. Review npm scripts and configure test-only services separately. Missing or unsupported tests are reported as not tested. Source discovery does not establish execution coverage.",
          }),
        },
        fetcher,
      ));
    await env.DB.prepare(
      "UPDATE project_repositories SET setup_pr_url=?,check_setup_state='AWAITING_MERGE',check_setup_error=NULL,check_setup_updated_at=? WHERE project_id=?",
    )
      .bind(pr.html_url, nowIso(), projectId)
      .run();
    return { state: "AWAITING_MERGE", url: pr.html_url };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE project_repositories SET check_setup_state='FAILED',check_setup_error=?,check_setup_updated_at=? WHERE project_id=?",
    )
      .bind(
        error instanceof ApiError
          ? error.message
          : "Project check setup failed. Retry setup; source discovery can continue.",
        nowIso(),
        projectId,
      )
      .run();
    throw error;
  }
}

export async function startInitialChecks(
  env: Env,
  projectId: string,
  fetcher: typeof fetch = fetch,
) {
  const result = await prepareRepositoryChecks(env, projectId, fetcher);
  if (result.state !== "READY") return result;
  try {
    return await dispatchRepositoryChecks(env, projectId, fetcher);
  } catch (error) {
    if (error instanceof ApiError && error.code === "CHECK_ALREADY_REQUESTED")
      return { state: "QUEUED", url: result.url };
    throw error;
  }
}

// Explicit owner action: propose a runner upgrade as a PR, never change the default branch.
export async function upgradeRepositoryChecks(
  env: Env,
  projectId: string,
  fetcher: typeof fetch = fetch,
) {
  const repo = await connectedRepository(env, projectId),
    origin = new URL(env.PUBLIC_APP_ORIGIN ?? "http://localhost");
  if (origin.protocol !== "https:" || !/^[a-f0-9]{40}$/.test(env.TRACEYARD_RUNNER_REF ?? ""))
    throw badRequest(
      "RUNNER_CONFIGURATION_REQUIRED",
      "Configure the public HTTPS origin and reviewed runner commit first.",
    );
  const path = `/repos/${repo.full_name}`,
    branch = `traceyard/runner-${projectId}-${env.TRACEYARD_RUNNER_REF!.slice(0, 8)}`;
  if (
    !(await optional(
      githubRequest(env, repo.installation_id, `${path}/git/ref/heads/${branch}`, {}, fetcher),
    ))
  ) {
    const commit = await githubRequest<{ sha: string }>(
      env,
      repo.installation_id,
      `${path}/commits/${encodeURIComponent(repo.default_branch)}`,
      {},
      fetcher,
    );
    await githubRequest(
      env,
      repo.installation_id,
      `${path}/git/refs`,
      { method: "POST", body: JSON.stringify({ ref: "refs/heads/" + branch, sha: commit.sha }) },
      fetcher,
    );
  }
  const file = `${path}/contents/.github/workflows/traceyard.yml`,
    existing = await optional(
      githubRequest<{ content: string; sha: string }>(
        env,
        repo.installation_id,
        file + "?ref=" + encodeURIComponent(branch),
        {},
        fetcher,
      ),
    );
  const content = btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(
        runnerWorkflow(origin.origin, repo.default_branch, env.TRACEYARD_RUNNER_REF!),
      ),
    ),
  );
  if (existing?.content.replace(/\s/g, "") !== content)
    await githubRequest(
      env,
      repo.installation_id,
      file,
      {
        method: "PUT",
        body: JSON.stringify({
          message: "Update Traceyard runner for saved request tests",
          branch,
          content,
          ...(existing ? { sha: existing.sha } : {}),
        }),
      },
      fetcher,
    );
  const prs = await githubRequest<{ html_url: string }[]>(
    env,
    repo.installation_id,
    `${path}/pulls?state=open&head=${encodeURIComponent(repo.full_name.split("/")[0] + ":" + branch)}`,
    {},
    fetcher,
  );
  const pr =
    prs[0] ??
    (await githubRequest<{ html_url: string }>(
      env,
      repo.installation_id,
      `${path}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Update Traceyard project test runner",
          head: branch,
          base: repo.default_branch,
          body: "Updates the immutable runner and adds saved request-test dispatch. Tests run only against a local application inside the GitHub runner. Review the workflow diff and npm scripts before merging. No application secrets or provider credentials are added. The default branch is unchanged until you merge this PR.",
        }),
      },
      fetcher,
    ));
  return { url: pr.html_url };
}
