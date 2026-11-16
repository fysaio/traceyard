import { Hono } from "hono";
import { z } from "zod";
import { reportSchema } from "../../../shared/repository/contracts";
import { spanBatchSchema, redact } from "../../../shared/contracts/traces";
import { runnerWorkflow } from "../../repositories/runner-workflow";
import {
  githubRequest,
  githubConfigured,
  installationOwned,
  verifyWebhook,
} from "../../repositories/github";
import { runnerPrincipal } from "../../repositories/runner-auth";
import { ownedProject, keyPrincipal } from "../../integrations/access";
import { ingestSpans } from "./traces";
import {
  badRequest,
  forbidden,
  notFound,
  parseWith,
  serviceUnavailable,
  conflict,
} from "../errors";
import { getRequestContext, readJsonBody, type AppEnv } from "../middleware";
import { nowIso } from "../../lib/time";
import { sha256Hex, randomId } from "../../lib/crypto";
import type { RepositoryRecord, RepositoryJob } from "../../../shared/repository/contracts";
interface GitHubRepo {
  id: number;
  full_name: string;
  default_branch: string;
  owner: { id: number; type: string };
}
export function createRepositoryRoutes(fetcher: typeof fetch = fetch) {
  const routes = new Hono<AppEnv>();
  const data = (c: Parameters<typeof getRequestContext>[0], value: unknown) => ({
    data: value,
    meta: { requestId: getRequestContext(c).requestId },
  });
  routes.post("/github/webhook", async (c) => {
    const size = Number(c.req.header("content-length") ?? 0);
    if (size > 1024 * 1024) throw badRequest("PAYLOAD_TOO_LARGE", "Webhook exceeds 1 MB.");
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > 1024 * 1024)
      throw badRequest("PAYLOAD_TOO_LARGE", "Webhook exceeds 1 MB.");
    if (!(await verifyWebhook(c.env, raw, c.req.header("x-hub-signature-256") ?? "")))
      throw forbidden("WEBHOOK_INVALID", "Invalid GitHub webhook signature.");
    const digest = await sha256Hex(raw);
    if (
      await c.env.DB.prepare("SELECT digest FROM github_webhook_deliveries WHERE digest=?")
        .bind(digest)
        .first()
    )
      return c.json(data(c, { received: true }));
    const event = c.req.header("x-github-event"),
      b = JSON.parse(raw) as {
        action: string;
        installation?: { id: number; account: { id: number; login: string; type: string } };
        repository?: { id: number };
        workflow_run?: {
          id: number;
          run_attempt: number;
          path: string;
          head_branch: string;
          head_sha: string;
          head_repository: { id: number };
          conclusion: string | null;
        };
      };
    if (event === "installation" && b.installation) {
      const i = b.installation;
      if (b.action === "deleted")
        await c.env.DB.prepare(
          "UPDATE github_installations SET suspended=1,updated_at=? WHERE id=?",
        )
          .bind(nowIso(), i.id)
          .run();
      else if (i.account.type === "User")
        await c.env.DB.prepare(
          "INSERT INTO github_installations(id,account_id,account_login,suspended,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_login=excluded.account_login,suspended=excluded.suspended,updated_at=excluded.updated_at",
        )
          .bind(
            i.id,
            String(i.account.id),
            i.account.login,
            b.action === "suspend" ? 1 : 0,
            nowIso(),
          )
          .run();
    }
    if (event === "workflow_run" && b.repository && b.workflow_run) {
      const w = b.workflow_run;
      const r = await c.env.DB.prepare(
        "SELECT r.* FROM project_repositories r JOIN github_installations g ON g.id=r.installation_id WHERE repository_id=? AND g.suspended=0",
      )
        .bind(b.repository.id)
        .first<RepositoryRecord>();
      if (
        r &&
        w.path === ".github/workflows/traceyard.yml" &&
        w.head_repository.id === r.repository_id &&
        w.head_branch === r.default_branch
      ) {
        const id = String(w.id) + "-" + String(w.run_attempt);
        const old = await c.env.DB.prepare(
          "SELECT * FROM repository_jobs WHERE project_id=? AND id=?",
        )
          .bind(r.project_id, id)
          .first<RepositoryJob>();
        const events = (old ? JSON.parse(old.events_json) : []) as {
          phase: string;
          status: string;
          message: string;
          at: string;
        }[];
        const terminal = b.action === "completed";
        const status = terminal
          ? w.conclusion === "cancelled"
            ? "CANCELLED"
            : w.conclusion === "success"
              ? "SKIPPED"
              : "FAILED"
          : "RUNNING";
        events.push({
          phase: "runner",
          status,
          message: terminal
            ? "GitHub runner " +
              w.conclusion +
              ". " +
              (w.conclusion === "success"
                ? "No completed test report was received."
                : "Inspect the GitHub build logs.")
            : "GitHub runner " + b.action + ".",
          at: nowIso(),
        });
        if (!old || old.status === "RUNNING")
          await c.env.DB.prepare(
            "INSERT INTO repository_jobs(id,project_id,commit_sha,source,phase,status,events_json,github_url,updated_at) VALUES(?,?,?,'github',?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET status=excluded.status,events_json=excluded.events_json,updated_at=excluded.updated_at",
          )
            .bind(
              id,
              r.project_id,
              w.head_sha,
              terminal ? "complete" : "discovery",
              status,
              JSON.stringify(events.slice(-30)),
              "https://github.com/" + r.full_name + "/actions/runs/" + w.id,
              nowIso(),
            )
            .run();
        await c.env.DB.prepare(
          "UPDATE project_repositories SET runner_enabled=1 WHERE project_id=?",
        )
          .bind(r.project_id)
          .run();
      }
    }
    await c.env.DB.prepare(
      "INSERT INTO github_webhook_deliveries(digest,received_at) VALUES(?,?) ON CONFLICT DO NOTHING",
    )
      .bind(digest, nowIso())
      .run();
    return c.json(data(c, { received: true }));
  });
  routes.get("/repositories", async (c) => {
    const auth = c.get("auth");
    if (!auth) throw forbidden("AUTHENTICATION_REQUIRED", "Sign in to connect a repository.");
    const installations = await c.env.DB.prepare(
      "SELECT g.id FROM github_installations g JOIN identities i ON i.provider='github' AND i.provider_subject=g.account_id WHERE i.user_id=? AND g.suspended=0",
    )
      .bind(auth.user.id)
      .all<{ id: number }>();
    const repos: (GitHubRepo & { installationId: number })[] = [];
    if (githubConfigured(c.env))
      for (const i of installations.results) {
        for (let page = 1; page <= 5; page++) {
          const r = await githubRequest<{ repositories: GitHubRepo[] }>(
            c.env,
            i.id,
            `/installation/repositories?per_page=100&page=${page}`,
            {},
            fetcher,
          );
          repos.push(...r.repositories.map((repo) => ({ ...repo, installationId: i.id })));
          if (r.repositories.length < 100) break;
        }
      }
    return c.json(
      data(c, {
        configured: githubConfigured(c.env),
        installUrl: c.env.GITHUB_APP_SLUG
          ? "https://github.com/apps/" +
            encodeURIComponent(c.env.GITHUB_APP_SLUG) +
            "/installations/new"
          : null,
        items: repos.map((r) => ({
          id: r.id,
          name: r.full_name,
          installationId: r.installationId,
        })),
        scope: "Personal GitHub accounts; up to 500 repositories per installation.",
      }),
    );
  });
  routes.get("/projects/:projectId/repository", async (c) => {
    const { projectId } = await ownedProject(c);
    const repository = await c.env.DB.prepare(
      "SELECT * FROM project_repositories WHERE project_id=?",
    )
      .bind(projectId)
      .first<RepositoryRecord>();
    const jobs = await c.env.DB.prepare(
      "SELECT * FROM repository_jobs WHERE project_id=? ORDER BY updated_at DESC LIMIT 20",
    )
      .bind(projectId)
      .all<RepositoryJob>();
    return c.json(data(c, { repository, jobs: jobs.results }));
  });
  async function startScan(c: Parameters<typeof ownedProject>[0], projectId: string) {
    if (!c.env.REPOSITORY_DISCOVERY)
      throw serviceUnavailable(
        "DISCOVERY_UNCONFIGURED",
        "The repository discovery Workflow binding needs configuration.",
      );
    const scanId = randomId("scan");
    const started = await c.env.DB.prepare(
      "UPDATE project_repositories SET status='DISCOVERING',scan_id=?,last_error=NULL,updated_at=? WHERE project_id=? AND (status!='DISCOVERING' OR updated_at<?) RETURNING project_id",
    )
      .bind(scanId, nowIso(), projectId, new Date(Date.now() - 15 * 60 * 1000).toISOString())
      .first();
    if (!started) throw conflict("DISCOVERY_RUNNING", "Repository discovery is already running.");
    try {
      await c.env.REPOSITORY_DISCOVERY.create({ id: scanId, params: { projectId, scanId } });
    } catch (error) {
      await c.env.DB.prepare(
        "UPDATE project_repositories SET status='FAILED',last_error='Discovery could not be started.',updated_at=? WHERE project_id=?",
      )
        .bind(nowIso(), projectId)
        .run();
      throw error;
    }
  }
  routes.post("/projects/:projectId/repository", async (c) => {
    const { userId, projectId } = await ownedProject(c),
      b = parseWith(
        z
          .object({
            repositoryId: z.number().int().positive(),
            installationId: z.number().int().positive(),
          })
          .strict(),
        await readJsonBody(c),
        "Choose a repository.",
      );
    if (!githubConfigured(c.env))
      throw serviceUnavailable("GITHUB_APP_UNCONFIGURED", "GitHub App setup is incomplete.");
    if (!(await installationOwned(c.env.DB, userId, b.installationId)))
      throw notFound("Installation not found.");
    const list = await githubRequest<GitHubRepo>(
      c.env,
      b.installationId,
      `/repositories/${b.repositoryId}`,
      {},
      fetcher,
    );
    const identity = await c.env.DB.prepare(
      "SELECT account_id FROM github_installations WHERE id=?",
    )
      .bind(b.installationId)
      .first<{ account_id: string }>();
    if (list.owner.type !== "User" || String(list.owner.id) !== identity?.account_id)
      throw forbidden(
        "REPOSITORY_OWNER_MISMATCH",
        "Select a repository owned by this personal installation.",
      );
    const existing = await c.env.DB.prepare(
      "SELECT project_id FROM project_repositories WHERE repository_id=? OR project_id=?",
    )
      .bind(list.id, projectId)
      .first();
    if (existing)
      throw conflict(
        "REPOSITORY_ALREADY_CONNECTED",
        "This project or repository is already connected.",
      );
    await c.env.DB.prepare(
      "INSERT INTO project_repositories(project_id,repository_id,installation_id,full_name,default_branch,status,updated_at) VALUES(?,?,?,?,?,'CONNECTED',?)",
    )
      .bind(projectId, list.id, b.installationId, list.full_name, list.default_branch, nowIso())
      .run();
    await startScan(c, projectId);
    return c.json(data(c, { connected: true }), 201);
  });
  routes.post("/projects/:projectId/repository/scan", async (c) => {
    const { projectId } = await ownedProject(c),
      repo = await c.env.DB.prepare(
        "SELECT installation_id FROM project_repositories WHERE project_id=?",
      )
        .bind(projectId)
        .first<{ installation_id: number | null }>();
    if (!repo?.installation_id)
      throw badRequest(
        "GITHUB_REPOSITORY_REQUIRED",
        "Select an installed GitHub repository first.",
      );
    await startScan(c, projectId);
    return c.json(data(c, { started: true }), 202);
  });
  routes.post("/projects/:projectId/repository/setup", async (c) => {
    const { projectId, userId } = await ownedProject(c),
      r = await c.env.DB.prepare("SELECT * FROM project_repositories WHERE project_id=?")
        .bind(projectId)
        .first<RepositoryRecord>();
    if (!r?.installation_id || !r.default_branch) throw notFound("GitHub repository not found.");
    if (!(await installationOwned(c.env.DB, userId, r.installation_id)))
      throw forbidden("INSTALLATION_UNAVAILABLE", "GitHub installation access was removed.");
    if (r.setup_pr_url) return c.json(data(c, { url: r.setup_pr_url }));
    const origin = c.env.PUBLIC_APP_ORIGIN ?? new URL(c.req.url).origin;
    if (!origin.startsWith("https://"))
      throw badRequest(
        "PUBLIC_ORIGIN_REQUIRED",
        "GitHub runners need a publicly reachable HTTPS Traceyard URL. Localhost cannot receive their results.",
      );
    if (!/^[a-f0-9]{40}$/.test(c.env.TRACEYARD_RUNNER_REF ?? ""))
      throw badRequest(
        "RUNNER_REF_REQUIRED",
        "Configure the immutable Traceyard runner commit first.",
      );
    const commit = await githubRequest<{ sha: string }>(
        c.env,
        r.installation_id,
        `/repos/${r.full_name}/commits/${encodeURIComponent(r.default_branch)}`,
        {},
        fetcher,
      ),
      branch = "traceyard/setup-" + crypto.randomUUID().slice(0, 8);
    await githubRequest(
      c.env,
      r.installation_id,
      `/repos/${r.full_name}/git/refs`,
      { method: "POST", body: JSON.stringify({ ref: "refs/heads/" + branch, sha: commit.sha }) },
      fetcher,
    );
    const workflow = runnerWorkflow(origin, r.default_branch, c.env.TRACEYARD_RUNNER_REF!);
    // This is an additive install. Existing Traceyard workflow files are never silently overwritten.
    await githubRequest(
      c.env,
      r.installation_id,
      `/repos/${r.full_name}/contents/.github/workflows/traceyard.yml`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: "Install Traceyard discovery and checks",
          branch,
          content: btoa(String.fromCharCode(...new TextEncoder().encode(workflow))),
        }),
      },
      fetcher,
    );
    const pr = await githubRequest<{ html_url: string }>(
      c.env,
      r.installation_id,
      `/repos/${r.full_name}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Connect Traceyard discovery and test runs",
          head: branch,
          base: r.default_branch,
          body: "Adds a pinned Traceyard runner on GitHub-hosted infrastructure. Discovers supported source entry points, runs npm install/build/test scripts and sends operational metadata to Traceyard using GitHub OIDC. No Traceyard API key is stored. Review package scripts and use test-only service configuration. Missing tests are reported as skipped. Runtime capture covers supported Node.js libraries; source discovery is not full execution coverage.",
        }),
      },
      fetcher,
    );
    await c.env.DB.prepare("UPDATE project_repositories SET setup_pr_url=? WHERE project_id=?")
      .bind(pr.html_url, projectId)
      .run();
    return c.json(data(c, { url: pr.html_url }), 201);
  });
  routes.post("/projects/:projectId/repository/run", async (c) => {
    const { projectId, userId } = await ownedProject(c),
      r = await c.env.DB.prepare("SELECT * FROM project_repositories WHERE project_id=?")
        .bind(projectId)
        .first<RepositoryRecord>();
    if (
      !r?.installation_id ||
      !r.default_branch ||
      !(await installationOwned(c.env.DB, userId, r.installation_id))
    )
      throw notFound("GitHub repository not found.");
    await githubRequest(
      c.env,
      r.installation_id,
      `/repos/${r.full_name}/actions/workflows/traceyard.yml/dispatches`,
      { method: "POST", body: JSON.stringify({ ref: r.default_branch }) },
      fetcher,
    );
    return c.json(
      data(c, { url: "https://github.com/" + r.full_name + "/actions/workflows/traceyard.yml" }),
      202,
    );
  });
  routes.post("/v1/repository/register", async (c) => {
    const key = await keyPrincipal(c, "traces:write"),
      b = parseWith(
        z.object({ name: z.string().min(1).max(150) }).strict(),
        await readJsonBody(c),
        "Enter the local project name.",
      );
    await c.env.DB.prepare(
      "INSERT INTO project_repositories(project_id,full_name,status,updated_at) VALUES(?,?,'DISCOVERING',?) ON CONFLICT(project_id) DO NOTHING",
    )
      .bind(key.projectId, b.name, nowIso())
      .run();
    return c.json(data(c, { projectId: key.projectId }));
  });
  routes.post("/v1/repository-runs", async (c) => {
    const who = await runnerPrincipal(c, fetcher),
      b = parseWith(reportSchema, await readJsonBody(c), "Invalid runner report.");
    if (who.source === "local" && !b.id.startsWith("local-"))
      throw badRequest("LOCAL_RUN_ID_REQUIRED", "Local check IDs must start with local-.");
    if (who.source === "github" && (b.id !== who.runId || b.sha !== who.sha))
      throw forbidden("RUN_IDENTITY_MISMATCH", "The report does not match the signed GitHub run.");
    const repo = await c.env.DB.prepare("SELECT * FROM project_repositories WHERE project_id=?")
      .bind(who.projectId)
      .first<RepositoryRecord>();
    if (!repo) throw notFound("Connect a repository first.");
    if (who.source === "github")
      await c.env.DB.prepare("UPDATE project_repositories SET runner_enabled=1 WHERE project_id=?")
        .bind(who.projectId)
        .run();
    const old = await c.env.DB.prepare("SELECT * FROM repository_jobs WHERE project_id=? AND id=?")
      .bind(who.projectId, b.id)
      .first<RepositoryJob>();
    if (old && old.source !== who.source)
      throw conflict("RUN_SOURCE_MISMATCH", "This check belongs to another runner source.");
    if (old && old.status !== "RUNNING") return c.json(data(c, { received: true }));
    const events = (old ? JSON.parse(old.events_json) : []) as {
      phase: string;
      status: string;
      message: string;
      at: string;
    }[];
    const order = ["discovery", "install", "build", "test", "complete"];
    if (old && order.indexOf(b.phase) < order.indexOf(old.phase))
      throw conflict("RUN_PHASE_ORDER", "Runner phases cannot move backwards.");
    if (
      b.phase === "complete" &&
      b.status === "SUCCEEDED" &&
      (!events.some((e) => e.phase === "test" && e.status === "SUCCEEDED") ||
        events.some((e) => e.status === "FAILED"))
    )
      throw badRequest(
        "TEST_EVIDENCE_REQUIRED",
        "A successful result needs a successful test phase.",
      );
    events.push({
      phase: b.phase,
      status: b.status,
      message: String(redact(b.message)),
      at: nowIso(),
    });
    const url =
      who.source === "github"
        ? "https://github.com/" + repo.full_name + "/actions/runs/" + who.runId!.split("-")[0]
        : null;
    await c.env.DB.prepare(
      "INSERT INTO repository_jobs(id,project_id,commit_sha,source,phase,status,events_json,github_url,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET phase=excluded.phase,status=excluded.status,events_json=excluded.events_json,updated_at=excluded.updated_at",
    )
      .bind(
        b.id,
        who.projectId,
        b.sha,
        who.source,
        b.phase,
        b.phase === "complete" ? b.status : "RUNNING",
        JSON.stringify(events.slice(-30)),
        url,
        nowIso(),
      )
      .run();
    if (b.operations && (who.source === "github" || repo.repository_id === null))
      await c.env.DB.prepare(
        "UPDATE project_repositories SET commit_sha=?,scan_json=?,status='DISCOVERED',last_error=NULL,updated_at=? WHERE project_id=?",
      )
        .bind(
          b.sha,
          JSON.stringify({
            operations: b.operations,
            filesScanned: b.filesScanned ?? 0,
            warnings: b.warnings ?? [],
          }),
          nowIso(),
          who.projectId,
        )
        .run();
    return c.json(data(c, { received: true }));
  });
  routes.post("/v1/otlp/v1/traces", async (c) => {
    const who = await runnerPrincipal(c, fetcher),
      body = await readJsonBody(c);
    const { convertOtlp } = await import("../../repositories/otlp");
    const spans = parseWith(
      spanBatchSchema,
      { spans: convertOtlp(body) },
      "Invalid OTLP JSON spans.",
    ).spans;
    if (who.source === "github")
      for (const span of spans) {
        span.attributes["traceyard.run.id"] = who.runId;
        span.attributes["service.version"] = who.sha;
      }
    await ingestSpans(c.env.DB, who.projectId, spans);
    return c.json({});
  });
  return routes;
}
