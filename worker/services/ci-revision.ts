import { badRequest } from "../api/errors";
import { repositoryActionsReader } from "../repositories/github";

const shaPattern = /^[a-f0-9]{40}$/i;
const numberPattern = /^[1-9]\d{0,17}$/;
const pasteSha = "Open the job log and paste the full SHA from the checkout used by the test.";

export function parseCiLink(value: string, repository: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest("INVALID_CI_LINK", "Paste a GitHub Actions run or job link.");
  }
  const match = url.pathname.match(
    /^\/([\w.-]+\/[\w.-]+)\/actions\/runs\/([1-9]\d{0,17})(?:\/attempts\/([1-9]\d{0,17}))?(?:\/job\/([1-9]\d{0,17}))?\/?$/,
  );
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    !match?.[1] ||
    !match[2]
  )
    throw badRequest("INVALID_CI_LINK", "Paste a GitHub Actions run or job link.");
  if (match[1].toLowerCase() !== repository.toLowerCase())
    throw badRequest(
      "CI_REPOSITORY_MISMATCH",
      "Use an Actions link from the connected repository.",
    );
  return { runId: match[2], attempt: match[3], jobId: match[4] };
}

export function readCheckoutRevision(log: string, repository: string) {
  const lines = log.split(/\r?\n/).map((line) =>
    line
      .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, "")
      // eslint-disable-next-line no-control-regex -- GitHub can colorize the checkout log.
      .replace(/\x1b\[[\d;]*m/g, "")
      .trim(),
  );
  const checkouts: { commit: string; merge: boolean }[] = [];
  let observing = false,
    merge = false;
  for (const [index, line] of lines.entries()) {
    const checkout = line.match(/^##\[group\]Syncing repository: (\S+)$/i);
    if (checkout?.[1]) {
      observing = checkout[1].toLowerCase() === repository.toLowerCase();
      merge = false;
    }
    if (!observing) continue;
    if (/^\[command\].*\s(?:checkout|fetch)\s.*refs\/(?:remotes\/)?pull\/\d+\/merge\b/.test(line))
      merge = true;
    if (/^\[command\].*\bgit\s+log\s+-1\s+--format=%H$/.test(line)) {
      const commit = lines[index + 1];
      if (commit && shaPattern.test(commit))
        checkouts.push({ commit: commit.toLowerCase(), merge });
      observing = false;
    }
  }
  return checkouts.length === 1 ? checkouts[0] : null;
}

export async function resolveCiRevision(
  env: Env,
  projectId: string,
  url: string,
  fetcher: typeof fetch = fetch,
) {
  const repo = await env.DB.prepare(
    "SELECT full_name,repository_id,installation_id FROM project_repositories WHERE project_id=?",
  )
    .bind(projectId)
    .first<{ full_name: string; repository_id: number; installation_id: number | null }>();
  if (!repo?.installation_id)
    throw badRequest("REPOSITORY_ACCESS_REQUIRED", "Connect your GitHub repository first.");
  const { runId, attempt, jobId } = parseCiLink(url, repo.full_name);
  const gh = await repositoryActionsReader(env, repo.installation_id, repo.repository_id, fetcher);
  const path = `/repos/${repo.full_name}/actions`;
  const run = await gh.get<{
    event: string;
    head_sha: string;
    run_attempt: number;
    pull_requests?: { head?: { sha?: string } }[];
  }>(`${path}/runs/${runId}${attempt ? `/attempts/${attempt}` : ""}`);
  type Job = {
    id: number;
    run_id: number;
    run_attempt: number;
    conclusion: string | null;
    status: string;
  };
  let job: Job;
  if (jobId) {
    job = await gh.get<Job>(`${path}/jobs/${jobId}`);
    if (String(job.run_id) !== runId || (attempt && String(job.run_attempt) !== attempt))
      throw badRequest(
        "CI_JOB_MISMATCH",
        "This job does not belong to the linked Actions run or attempt.",
      );
  } else {
    const currentAttempt = attempt ?? String(run.run_attempt);
    if (!numberPattern.test(currentAttempt))
      throw badRequest("CI_ATTEMPT_UNKNOWN", `The run attempt is unavailable. ${pasteSha}`);
    const { jobs, total_count } = await gh.get<{ jobs: Job[]; total_count: number }>(
      `${path}/runs/${runId}/attempts/${currentAttempt}/jobs?per_page=100`,
    );
    const failed = jobs.filter((j) => ["failure", "timed_out"].includes(j.conclusion ?? ""));
    if (total_count > jobs.length || failed.length !== 1 || !failed[0])
      throw badRequest(
        "CI_JOB_REQUIRED",
        "Open the specific job that ran the test and paste its job link.",
      );
    job = failed[0];
  }
  if (job.status !== "completed")
    throw badRequest(
      "CI_JOB_INCOMPLETE",
      "Wait for the CI job to finish, or enter its tested commit yourself.",
    );
  const log = await gh.log(`${path}/jobs/${job.id}/logs`).catch(() => null);
  const checkout = log && readCheckoutRevision(log, repo.full_name);
  if (!checkout)
    throw badRequest(
      "CI_CHECKOUT_UNKNOWN",
      `Traceyard could not identify a single checkout in this job. ${pasteSha}`,
    );
  const pullRequest = run.event === "pull_request" || run.event === "pull_request_target";
  const head =
    run.pull_requests?.some((pr) => pr.head?.sha === checkout.commit) ||
    run.head_sha === checkout.commit;
  const kind = checkout.merge
    ? "PR merge commit"
    : pullRequest && head
      ? "PR head commit"
      : "Job checkout commit";
  if (pullRequest && kind === "Job checkout commit")
    throw badRequest(
      "CI_CHECKOUT_UNKNOWN",
      `The job checkout could not be identified as the PR head or merge commit. ${pasteSha}`,
    );
  return {
    commit: checkout.commit,
    kind,
    jobUrl: `https://github.com/${repo.full_name}/actions/runs/${runId}/job/${job.id}`,
  };
}
