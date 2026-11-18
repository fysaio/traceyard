import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { syncRepositoryChecks } from "../../worker/repositories/check-sync";
import { getOrCreateGitHubIdentity } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";

async function seed() {
  const user = await getOrCreateGitHubIdentity(env.DB, {
    id: 7301,
    login: "sync-owner",
    name: "Owner",
    avatarUrl: null,
  });
  const project = (await getDefaultProjectId(env.DB, user.id))!;
  const at = new Date(Date.now() - 20 * 60000).toISOString();
  await env.DB.prepare(
    "INSERT INTO github_installations(id,account_id,account_login,suspended,updated_at) VALUES(7,'7301','sync-owner',0,?)",
  )
    .bind(at)
    .run();
  await env.DB.prepare(
    "INSERT INTO project_repositories(project_id,repository_id,full_name,installation_id,default_branch,status,updated_at) VALUES(?,71,'sync-owner/app',7,'main','READY',?)",
  )
    .bind(project, at)
    .run();
  const events = JSON.stringify([{ phase: "test", status: "RUNNING", message: "Testing", at }]);
  await env.DB.prepare(
    "INSERT INTO repository_jobs(id,project_id,commit_sha,source,phase,status,events_json,updated_at) VALUES('123-1',?,?,'github','test','RUNNING',?,?)",
  )
    .bind(project, "a".repeat(40), events, at)
    .run();
  return { project, at };
}
const completed = {
  id: 123,
  run_attempt: 1,
  status: "completed",
  conclusion: "failure",
  head_sha: "a".repeat(40),
  head_branch: "main",
  path: ".github/workflows/traceyard.yml",
  repository: { id: 71 },
};
async function job(project: string) {
  return env.DB.prepare("SELECT * FROM repository_jobs WHERE project_id=? AND id='123-1'")
    .bind(project)
    .first<{ status: string; phase: string; events_json: string; updated_at: string }>();
}

it("recovers a missed completion without requiring a webhook", async () => {
  const { project } = await seed();
  await syncRepositoryChecks(env, project, async () => completed);
  expect(await job(project)).toMatchObject({ status: "FAILED", phase: "complete" });
  expect(JSON.parse((await job(project))!.events_json).at(-1).message).toContain(
    "GitHub confirmed",
  );
});

it("throttles concurrent and repeated polls while preserving the last actual progress time", async () => {
  const { project, at } = await seed();
  let calls = 0;
  const lookup = async () => {
    calls++;
    return { ...completed, status: "in_progress", conclusion: null };
  };
  await Promise.all([
    syncRepositoryChecks(env, project, lookup),
    syncRepositoryChecks(env, project, lookup),
  ]);
  await syncRepositoryChecks(env, project, lookup);
  expect(calls).toBe(1);
  expect(await job(project)).toMatchObject({ status: "RUNNING", updated_at: at });
});

it("keeps an unavailable result uncertain and suppresses private error text", async () => {
  const { project, at } = await seed();
  await syncRepositoryChecks(env, project, async () => {
    throw Error("private-token-fixture");
  });
  const result = (await job(project))!;
  expect(result).toMatchObject({ status: "RUNNING", updated_at: at });
  expect(result.events_json).toContain("UNAVAILABLE");
  expect(result.events_json).not.toContain("private-token");
});

it("does not invent test success from a successful GitHub job", async () => {
  const { project } = await seed();
  await syncRepositoryChecks(env, project, async () => ({ ...completed, conclusion: "success" }));
  expect(await job(project)).toMatchObject({ status: "SKIPPED" });
});

it("rejects results from a different run attempt or repository", async () => {
  const { project } = await seed();
  await syncRepositoryChecks(env, project, async () => ({
    ...completed,
    run_attempt: 2,
    repository: { id: 99 },
  }));
  expect(await job(project)).toMatchObject({ status: "RUNNING" });
});

it("preserves received test evidence when GitHub confirms success", async () => {
  const { project } = await seed();
  await env.DB.prepare("UPDATE repository_jobs SET events_json=? WHERE project_id=? AND id='123-1'")
    .bind(
      JSON.stringify([
        {
          phase: "test",
          status: "SUCCEEDED",
          message: "Tests passed",
          at: new Date().toISOString(),
        },
      ]),
      project,
    )
    .run();
  await syncRepositoryChecks(env, project, async () => ({ ...completed, conclusion: "success" }));
  expect(await job(project)).toMatchObject({ status: "SUCCEEDED" });
});

it("recovers cancellation without treating it as successful testing", async () => {
  const { project } = await seed();
  await syncRepositoryChecks(env, project, async () => ({ ...completed, conclusion: "cancelled" }));
  expect(await job(project)).toMatchObject({ status: "CANCELLED" });
});

it("does not overwrite a runner report that arrives during reconciliation", async () => {
  const { project } = await seed();
  await syncRepositoryChecks(env, project, async () => {
    await env.DB.prepare(
      "UPDATE repository_jobs SET status='SUCCEEDED',events_json='[]' WHERE project_id=? AND id='123-1'",
    )
      .bind(project)
      .run();
    return completed;
  });
  expect(await job(project)).toMatchObject({ status: "SUCCEEDED", events_json: "[]" });
});
