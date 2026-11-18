import { badRequest, notFound } from "../api/errors";
import { installationOwned, githubRequest } from "./github";
import { nowIso } from "../lib/time";
import { finishManagedCheck } from "./managed";
import type { RepositoryRecord } from "../../shared/repository/contracts";
export async function cancelRepositoryCheck(
  env: Env,
  userId: string,
  projectId: string,
  id: string,
  fetcher: typeof fetch = fetch,
) {
  const dispatch = await env.DB.prepare(
    "SELECT runner_id FROM github_check_dispatches WHERE project_id=? AND id=?",
  )
    .bind(projectId, id)
    .first<{ runner_id: string | null }>();
  let job = await env.DB.prepare("SELECT * FROM repository_jobs WHERE project_id=? AND id=?")
    .bind(projectId, dispatch?.runner_id ?? id)
    .first<{ id: string; status: string; source: string }>();
  if (job?.source === "github-pending") {
    const cancelled = await env.DB.batch([
      env.DB.prepare(
        "UPDATE github_check_dispatches SET state='CANCELLED',updated_at=? WHERE id=? AND project_id=? AND runner_id IS NULL",
      ).bind(nowIso(), job.id, projectId),
      env.DB.prepare(
        "UPDATE repository_jobs SET status='CANCELLED',phase='complete',updated_at=? WHERE id=? AND project_id=? AND source='github-pending' AND EXISTS(SELECT 1 FROM github_check_dispatches WHERE id=? AND state='CANCELLED')",
      ).bind(nowIso(), job.id, projectId, job.id),
    ]);
    if (cancelled[0]?.meta.changes) return;
    // The runner may have bound between the read and cancellation claim.
    job = await env.DB.prepare(
      "SELECT j.* FROM repository_jobs j JOIN github_check_dispatches d ON d.runner_id=j.id AND d.project_id=j.project_id WHERE d.id=? AND d.project_id=?",
    )
      .bind(id, projectId)
      .first<{ id: string; status: string; source: string }>();
  }
  if (job?.source === "managed") {
    if (!["RUNNING", "QUEUED"].includes(job.status))
      throw badRequest("CHECK_FINISHED", "This check has already finished.");
    await finishManagedCheck(
      env,
      job.id,
      "CANCELLED",
      "This check was cancelled. Source discoveries remain available.",
    );
    await env.MANAGED_REPOSITORY_RUNNERS?.getByName(job.id).cancel();
    return;
  }
  const repo = await env.DB.prepare("SELECT * FROM project_repositories WHERE project_id=?")
    .bind(projectId)
    .first<RepositoryRecord>();
  if (
    !job ||
    job.source !== "github" ||
    !/^\d+-\d+$/.test(job.id) ||
    !repo?.installation_id ||
    !(await installationOwned(env.DB, userId, repo.installation_id))
  )
    throw notFound("GitHub check not found.");
  if (job.status !== "RUNNING")
    throw badRequest("CHECK_FINISHED", "This check has already finished.");
  await githubRequest(
    env,
    repo.installation_id,
    `/repos/${repo.full_name}/actions/runs/${job.id.split("-")[0]}/cancel`,
    { method: "POST" },
    fetcher,
  );
  return;
}
