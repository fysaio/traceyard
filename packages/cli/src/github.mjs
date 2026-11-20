import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  failingTestsFromLog,
  parseActionsUrl,
  readCheckoutRevision,
} from "../../core/src/ci-link.mjs";
import { UsageError, BlockedError } from "./errors.mjs";

const run = promisify(execFile);

/**
 * How to reach the GitHub API: a token from GITHUB_TOKEN or GH_TOKEN, else an
 * authenticated `gh` CLI, else anonymous requests (public repositories only).
 */
export async function githubAuth(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (token) return { kind: "token", token };
  try {
    await run("gh", ["auth", "status", "--hostname", "github.com"], { timeout: 5000 });
    return { kind: "gh" };
  } catch {
    return { kind: "anonymous" };
  }
}

const refused = (auth) =>
  new BlockedError(
    auth.kind === "anonymous"
      ? "GitHub needs a token to read this Actions run. Set GITHUB_TOKEN or sign in with `gh auth login`."
      : "GitHub refused access to this Actions run. Check that your token can read the repository.",
  );

function client(auth, fetcher) {
  if (auth.kind === "gh")
    return {
      async request(path, kind) {
        const call = (extra = []) =>
          run("gh", ["api", ...extra, path], { timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
        try {
          let result;
          try {
            result = await call();
          } catch (error) {
            // Newer gh refuses to print job logs (which contain ANSI colors) without this flag.
            if (!/escape sequences/.test(String(error.stderr ?? ""))) throw error;
            result = await call(["--allow-escape-sequences"]);
          }
          return kind === "text" ? result.stdout : JSON.parse(result.stdout);
        } catch (error) {
          if (/HTTP 40[134]/.test(String(error.stderr ?? error.message))) throw refused(auth);
          throw new BlockedError(
            "The gh CLI could not read the Actions run: " +
              String(error.stderr ?? error.message)
                .trim()
                .slice(0, 300),
          );
        }
      },
    };
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "traceyard-cli",
    "x-github-api-version": "2022-11-28",
    ...(auth.token ? { authorization: "Bearer " + auth.token } : {}),
  };
  return {
    async request(path, kind) {
      const response = await fetcher("https://api.github.com" + path, { headers });
      if ([401, 403, 404].includes(response.status)) throw refused(auth);
      if (!response.ok)
        throw new BlockedError(`GitHub returned ${response.status} for the Actions run.`);
      return kind === "text" ? response.text() : response.json();
    },
  };
}

/**
 * Turn a GitHub Actions link into the exact commit the job tested and the test
 * files that failed in it. `repository` is the local clone's GitHub "owner/name".
 */
export async function resolveActionsLink(
  url,
  repository,
  { auth = { kind: "anonymous" }, fetcher = globalThis.fetch } = {},
) {
  const link = parseActionsUrl(url);
  if (!link)
    throw new UsageError(
      "Pass a GitHub Actions run or job link, like https://github.com/owner/repo/actions/runs/123/job/456.",
    );
  if (repository && link.repository.toLowerCase() !== repository.toLowerCase())
    throw new UsageError(
      `This link is for ${link.repository}, but this clone's origin is ${repository}.`,
    );
  const api = client(auth, fetcher);
  const gh = {
    json: (path) => api.request(path, "json"),
    text: (path) => api.request(path, "text"),
  };
  const base = `/repos/${link.repository}/actions`;
  let jobId = link.jobId;
  if (!jobId) {
    const runInfo = await gh.json(
      `${base}/runs/${link.runId}${link.attempt ? `/attempts/${link.attempt}` : ""}`,
    );
    const attempt = link.attempt ?? String(runInfo.run_attempt);
    const { jobs } = await gh.json(
      `${base}/runs/${link.runId}/attempts/${attempt}/jobs?per_page=100`,
    );
    const failed = jobs.filter((job) => ["failure", "timed_out"].includes(job.conclusion ?? ""));
    if (failed.length !== 1)
      throw new UsageError(
        failed.length
          ? "More than one job failed in this run. Open the job that ran the test and pass its link."
          : "No job failed in this run. Pass the link of the job that ran the failing test.",
      );
    jobId = String(failed[0].id);
  }
  const job = await gh.json(`${base}/jobs/${jobId}`);
  if (String(job.run_id) !== link.runId)
    throw new UsageError("This job does not belong to the linked Actions run.");
  if (job.status !== "completed")
    throw new BlockedError("This CI job has not finished yet. Try again when it completes.");
  const log = await gh.text(`${base}/jobs/${jobId}/logs`);
  const checkout = readCheckoutRevision(log, link.repository);
  if (!checkout)
    throw new BlockedError(
      "Traceyard could not find a single checkout in this job's log. Pass the tested commit with --at instead.",
    );
  return {
    commit: checkout.commit,
    mergeCommit: checkout.merge,
    failingTests: failingTestsFromLog(log),
    jobUrl: `https://github.com/${link.repository}/actions/runs/${link.runId}/job/${jobId}`,
  };
}
