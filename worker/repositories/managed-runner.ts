import { DurableObject } from "cloudflare:workers";
import { installationAccessToken } from "./github";
import { finishManagedCheck } from "./managed";

export interface ManagedExecution {
  id: string;
  projectId: string;
  token: string;
}
export class RepositoryCheckRunner extends DurableObject<Env> {
  async enqueue(input: ManagedExecution) {
    if (await this.ctx.storage.get("input")) return;
    await this.ctx.storage.put("input", input);
    await this.ctx.storage.setAlarm(Date.now() + 100);
  }
  async cancel() {
    const input = await this.ctx.storage.get<ManagedExecution>("input");
    if (input)
      await finishManagedCheck(
        this.env,
        input.id,
        "CANCELLED",
        "This check was cancelled. Source discoveries remain available.",
      );
    await this.ctx.container?.destroy();
    await this.ctx.storage.deleteAll();
  }
  override async alarm() {
    await runManagedCheck(this.ctx, this.env);
  }
}

// Native container orchestration is separated from the RPC wrapper so its
// credential boundaries and interruption behavior can be tested without a VM.
export async function runManagedCheck(
  ctx: Pick<DurableObjectState, "storage" | "container">,
  env: Env,
) {
  const input = await ctx.storage.get<ManagedExecution>("input");
  if (!input) return;
  const row = await env.DB.prepare(
    "SELECT m.*,j.status AS job_status FROM managed_repository_checks m JOIN repository_jobs j ON j.id=m.id AND j.project_id=m.project_id WHERE m.id=?",
  )
    .bind(input.id)
    .first<{ state: string; job_status: string; created_at: string; snapshot_json: string }>();
  if (!row || !["QUEUED", "RUNNING"].includes(row.job_status)) {
    await ctx.container?.destroy();
    await ctx.storage.deleteAll();
    return;
  }
  if (await ctx.storage.get("started")) {
    await finishManagedCheck(
      env,
      input.id,
      "FAILED",
      "Execution was interrupted and its outcome is uncertain. It was not automatically repeated. Review the check, then start a new attempt.",
    );
    await ctx.container?.destroy();
    await ctx.storage.deleteAll();
    return;
  }
  if (Date.now() - Date.parse(row.created_at) > 10 * 60000) {
    await finishManagedCheck(
      env,
      input.id,
      "FAILED",
      "The runner queue timed out. Your source discoveries remain available.",
    );
    await ctx.storage.deleteAll();
    return;
  }
  const limit = Math.max(1, Math.min(8, Number(env.MANAGED_CHECK_CONCURRENCY_LIMIT) || 2));
  const admitted = await env.DB.prepare(
    "UPDATE managed_repository_checks SET state='RUNNING' WHERE id=? AND state='QUEUED' AND (SELECT COUNT(*) FROM managed_repository_checks WHERE state='RUNNING')<? RETURNING id",
  )
    .bind(input.id, limit)
    .first();
  if (!admitted) {
    await ctx.storage.setAlarm(Date.now() + 10000);
    return;
  }
  await ctx.storage.put("started", true);
  await env.DB.prepare(
    "UPDATE repository_jobs SET status='RUNNING',updated_at=? WHERE project_id=? AND id=? AND status='QUEUED'",
  )
    .bind(new Date().toISOString(), input.projectId, input.id)
    .run();
  const container = ctx.container;
  let githubToken: string | null = null;
  let phase: "starting" | "checkout" | "application" = "starting";
  const deadline = AbortSignal.timeout(10 * 60000);
  try {
    if (!container) throw Error("Runner container is unavailable");
    if (container.running) await container.destroy();
    container.start({
      image: container.images.runner!,
      entrypoint: ["sleep", "900"],
      enableInternet: true,
      instance: "standard-1",
    });
    const snapshot = JSON.parse(row.snapshot_json) as {
      fullName: string;
      sha: string;
      repositoryId: number;
      installationId: number;
    };
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(snapshot.fullName) ||
      !/^[a-f0-9]{40}$/.test(snapshot.sha)
    )
      throw Error("Invalid checkout snapshot");
    const exec = async (argv: string[], env: Record<string, string> = {}) => {
      const process = await container.exec(argv, {
        env,
        signal: deadline,
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await process.exitCode) !== 0) throw Error("Runner command failed");
    };
    phase = "checkout";
    githubToken = await installationAccessToken(
      env,
      snapshot.installationId,
      fetch,
      snapshot.repositoryId,
    );
    const checkoutEnv = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic " + btoa("x-access-token:" + githubToken),
      GIT_TERMINAL_PROMPT: "0",
    };
    // Only bootstrap gets GitHub credentials. No repository scripts run yet.
    await exec(["git", "init", "/workspace/application"]);
    await exec(
      [
        "git",
        "-C",
        "/workspace/application",
        "fetch",
        "--depth=1",
        "https://github.com/" + snapshot.fullName + ".git",
        snapshot.sha,
      ],
      checkoutEnv,
    );
    await exec(["git", "-C", "/workspace/application", "checkout", "--detach", "FETCH_HEAD"]);
    await exec(["rm", "-rf", "/workspace/application/.git"]);
    const checkoutAt = new Date().toISOString();
    const progress = await env.DB.prepare(
      "SELECT events_json FROM repository_jobs WHERE project_id=? AND id=? AND status='RUNNING'",
    )
      .bind(input.projectId, input.id)
      .first<{ events_json: string }>();
    if (!progress) throw Error("Check was cancelled");
    await env.DB.prepare(
      "UPDATE repository_jobs SET events_json=?,updated_at=? WHERE project_id=? AND id=? AND status='RUNNING'",
    )
      .bind(
        JSON.stringify([
          ...JSON.parse(progress.events_json),
          {
            phase: "checkout",
            status: "SUCCEEDED",
            message: "Downloaded the selected commit into an isolated workspace.",
            at: checkoutAt,
          },
        ]),
        checkoutAt,
        input.projectId,
        input.id,
      )
      .run();
    await fetch("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: { Authorization: "Bearer " + githubToken, "User-Agent": "Traceyard" },
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
    githubToken = null;
    const origin = new URL(env.PUBLIC_APP_ORIGIN!).origin;
    phase = "application";
    await exec(["node", "/opt/traceyard/agent/cli.mjs", "run", "/workspace/application"], {
      TRACEYARD_ORIGIN: origin,
      TRACEYARD_RUN_TOKEN: input.token,
      TRACEYARD_MANAGED_RUN_ID: input.id,
      TRACEYARD_COMMIT_SHA: snapshot.sha,
    });
    await finishManagedCheck(
      env,
      input.id,
      "FAILED",
      "The runner exited without a complete test report. The result is unverified; source discoveries are still available.",
    );
  } catch {
    await finishManagedCheck(
      env,
      input.id,
      "FAILED",
      deadline.aborted
        ? "The isolated check exceeded its 10-minute execution limit and was stopped. Source discoveries remain available."
        : phase === "starting"
          ? "The isolated workspace could not start. Source discoveries remain available; request a new check when the execution service is available."
          : phase === "checkout"
            ? "The selected commit could not be downloaded. Check repository access; source discoveries remain available."
            : "The runner stopped without a verified completion report. Review the last reported stage; source discoveries remain available. It was not automatically repeated.",
    );
  } finally {
    if (githubToken)
      await fetch("https://api.github.com/installation/token", {
        method: "DELETE",
        headers: { Authorization: "Bearer " + githubToken, "User-Agent": "Traceyard" },
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    await container?.destroy();
    await ctx.storage.deleteAll();
  }
}
