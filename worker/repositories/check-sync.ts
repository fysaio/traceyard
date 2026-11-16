import type { RepositoryJob, RepositoryRecord } from "../../shared/repository/contracts";
import { githubRequest } from "./github";

interface Event {
  phase: string;
  status: string;
  message: string;
  at: string;
}
interface GitHubRun {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  path: string;
  repository: { id: number };
}
type Lookup = (repo: RepositoryRecord, job: RepositoryJob) => Promise<GitHubRun>;

// Recover missed runner reports/webhooks without turning each UI poll into a
// GitHub API request. The claim preserves the actual last-progress timestamp.
export async function syncRepositoryChecks(
  env: Env,
  projectId: string,
  lookup?: Lookup,
  id?: string,
) {
  const repo = await env.DB.prepare("SELECT * FROM project_repositories WHERE project_id=?")
    .bind(projectId)
    .first<RepositoryRecord>();
  if (!repo?.repository_id || !repo.installation_id) return;
  const jobs = await env.DB.prepare(
    "SELECT * FROM repository_jobs WHERE project_id=? AND source='github' AND status='RUNNING' AND updated_at<?" +
      (id ? " AND id=?" : "") +
      " ORDER BY updated_at DESC LIMIT 2",
  )
    .bind(projectId, new Date(Date.now() - 60000).toISOString(), ...(id ? [id] : []))
    .all<RepositoryJob>();
  const read =
    lookup ??
    (async (repository, job) => {
      const [run, attempt] = job.id.split("-");
      return githubRequest<GitHubRun>(
        env,
        repository.installation_id!,
        `/repos/${repository.full_name}/actions/runs/${run}/attempts/${attempt}`,
        {},
        (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([
              ...(init?.signal ? [init.signal] : []),
              AbortSignal.timeout(5000),
            ]),
          }),
      );
    });
  await Promise.all(
    jobs.results.map(async (job) => {
      if (!/^\d+-\d+$/.test(job.id)) return;
      const events = JSON.parse(job.events_json) as Event[];
      if (events.some((e) => e.phase === "sync" && Date.now() - Date.parse(e.at) < 60000)) return;
      const at = new Date().toISOString();
      const claimed = JSON.stringify(
        [
          ...events,
          {
            phase: "sync",
            status: "RUNNING",
            message: "Checking GitHub for an updated result.",
            at,
          },
        ].slice(-30),
      );
      const claim = await env.DB.prepare(
        "UPDATE repository_jobs SET events_json=? WHERE project_id=? AND id=? AND status='RUNNING' AND events_json=? RETURNING id",
      )
        .bind(claimed, projectId, job.id, job.events_json)
        .first();
      if (!claim) return;
      try {
        const result = await read(repo, job);
        if (
          `${result.id}-${result.run_attempt}` !== job.id ||
          result.repository.id !== repo.repository_id ||
          result.path !== ".github/workflows/traceyard.yml" ||
          result.head_branch !== repo.default_branch ||
          result.head_sha !== job.commit_sha
        )
          throw Error("Run identity mismatch");
        if (result.status !== "completed") {
          const confirmed = JSON.stringify(
            [
              ...events,
              {
                phase: "sync",
                status: "CONFIRMED_RUNNING",
                message: "GitHub confirms this check is still queued or running.",
                at,
              },
            ].slice(-30),
          );
          await env.DB.prepare(
            "UPDATE repository_jobs SET events_json=? WHERE project_id=? AND id=? AND status='RUNNING' AND events_json=?",
          )
            .bind(confirmed, projectId, job.id, claimed)
            .run();
          return;
        }
        const status =
          result.conclusion === "cancelled"
            ? "CANCELLED"
            : result.conclusion === "success"
              ? events.some((e) => e.phase === "test" && e.status === "SUCCEEDED") &&
                !events.some((e) => e.status === "FAILED")
                ? "SUCCEEDED"
                : "SKIPPED"
              : "FAILED";
        const message =
          result.conclusion === "success" && status === "SKIPPED"
            ? "GitHub finished successfully, but Traceyard did not receive a completed test report. Inspect GitHub logs before treating this check as tested."
            : `GitHub confirmed this check ${status === "SUCCEEDED" ? "completed" : status === "CANCELLED" ? "was cancelled" : "failed"}. The final runner update was not received; open GitHub logs for details.`;
        const repaired = JSON.stringify(
          [...events, { phase: "complete", status, message, at }].slice(-30),
        );
        await env.DB.prepare(
          "UPDATE repository_jobs SET phase='complete',status=?,events_json=?,updated_at=? WHERE project_id=? AND id=? AND status='RUNNING' AND events_json=?",
        )
          .bind(status, repaired, at, projectId, job.id, claimed)
          .run();
      } catch {
        const failed = JSON.stringify(
          [
            ...events,
            {
              phase: "sync",
              status: "UNAVAILABLE",
              message:
                "Could not verify this check with GitHub. Open GitHub logs to confirm its status.",
              at,
            },
          ].slice(-30),
        );
        await env.DB.prepare(
          "UPDATE repository_jobs SET events_json=? WHERE project_id=? AND id=? AND status='RUNNING' AND events_json=?",
        )
          .bind(failed, projectId, job.id, claimed)
          .run();
      }
    }),
  );
}
