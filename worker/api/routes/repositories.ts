import { Hono } from "hono";
import { z } from "zod";
import { reportSchema } from "../../../shared/repository/contracts";
import { spanBatchSchema, redact } from "../../../shared/contracts/traces";
import { prepareGitHubChecks, approveGitHubChecks } from "../../repositories/github-checks";
import { dispatchRepositoryChecks } from "../../repositories/checks";
import { getOwnedProject } from "../../persistence/projects";
import {
  githubRequest,
  githubConfigured,
  installationOwned,
  syncPersonalInstallation,
  verifyWebhook,
} from "../../repositories/github";
import { runnerPrincipal, runnerRevision } from "../../repositories/runner-auth";
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
        ref?: string;
        after?: string;
        deleted?: boolean;
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
    if (event === "push" && b.repository && !b.deleted && /^[a-f0-9]{40}$/.test(b.after ?? "")) {
      const repo = await c.env.DB.prepare(
        "SELECT r.* FROM project_repositories r JOIN github_installations g ON g.id=r.installation_id WHERE r.repository_id=? AND g.suspended=0",
      )
        .bind(b.repository.id)
        .first<RepositoryRecord>();
      if (repo?.installation_id && b.ref === "refs/heads/" + repo.default_branch) {
        const head = await githubRequest<{ sha: string }>(
          c.env,
          repo.installation_id,
          `/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch!)}`,
          {},
          fetcher,
        );
        // Delayed webhook deliveries must not roll discovery back to an older push.
        if (head.sha === b.after)
          await startScan(c, repo.project_id, true, b.after, repo.scan_id ?? null);
      }
    }
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
          "UPDATE project_repositories SET runner_enabled=1,check_setup_state='READY',check_setup_error=NULL WHERE project_id=?",
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
    const installation = githubConfigured(c.env)
      ? await syncPersonalInstallation(c.env, auth.user.id, fetcher)
      : null;
    const installations = installation && !installation.suspended ? [installation] : [];
    const repos: (GitHubRepo & { installationId: number })[] = [];
    if (githubConfigured(c.env))
      for (const i of installations) {
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
        installationCount: installation ? 1 : 0,
        manageUrl: installation
          ? `https://github.com/settings/installations/${installation.id}`
          : null,
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
  routes.post("/repositories/connect", async (c) => {
    const auth = c.get("auth");
    if (!auth) throw forbidden("AUTHENTICATION_REQUIRED", "Sign in to connect a repository.");
    const body = parseWith(
      z
        .object({
          repositoryId: z.number().int().positive(),
          installationId: z.number().int().positive(),
        })
        .strict(),
      await readJsonBody(c),
      "Choose a repository.",
    );
    if (!githubConfigured(c.env) || !c.env.REPOSITORY_DISCOVERY)
      throw serviceUnavailable(
        "GITHUB_APP_UNCONFIGURED",
        "Repository connection needs GitHub App and discovery configuration.",
      );
    if (!(await installationOwned(c.env.DB, auth.user.id, body.installationId)))
      throw notFound("Installation not found.");
    const repo = await githubRequest<GitHubRepo>(
      c.env,
      body.installationId,
      `/repositories/${body.repositoryId}`,
      {},
      fetcher,
    );
    const installation = await c.env.DB.prepare(
      "SELECT account_id FROM github_installations WHERE id=?",
    )
      .bind(body.installationId)
      .first<{ account_id: string }>();
    if (repo.owner.type !== "User" || String(repo.owner.id) !== installation?.account_id)
      throw forbidden(
        "REPOSITORY_OWNER_MISMATCH",
        "Select a repository owned by this personal installation.",
      );
    async function existing() {
      const row = await c.env.DB.prepare(
        "SELECT project_id FROM project_repositories WHERE repository_id=?",
      )
        .bind(repo.id)
        .first<{ project_id: string }>();
      return row ? await getOwnedProject(c.env.DB, auth!.user.id, row.project_id) : null;
    }
    const connected = await existing();
    if (connected) return c.json(data(c, { project: connected, existing: true }));
    const id = randomId("prj"),
      at = nowIso();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO projects(id,slug,name,kind,created_at,owner_user_id) VALUES(?,?,?,'standard',?,?)",
        ).bind(id, "project-" + id.slice(4), repo.full_name.slice(0, 80), at, auth.user.id),
        c.env.DB.prepare(
          "INSERT INTO project_repositories(project_id,repository_id,installation_id,full_name,default_branch,status,updated_at) VALUES(?,?,?,?,?,'CONNECTED',?)",
        ).bind(id, repo.id, body.installationId, repo.full_name, repo.default_branch, at),
      ]);
    } catch (error) {
      const raced = await existing();
      if (raced) return c.json(data(c, { project: raced, existing: true }));
      throw error;
    }
    // The saved project remains visible if the background binding cannot start.
    try {
      await startScan(c, id, true);
    } catch {
      /* startScan persists its failure for retry. */
    }
    return c.json(
      data(c, { project: await getOwnedProject(c.env.DB, auth.user.id, id), existing: false }),
      201,
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
  async function startScan(
    c: Parameters<typeof ownedProject>[0],
    projectId: string,
    checks = false,
    commitSha?: string,
    expectedScan?: string | null,
  ) {
    if (!c.env.REPOSITORY_DISCOVERY)
      throw serviceUnavailable(
        "DISCOVERY_UNCONFIGURED",
        "The repository discovery Workflow binding needs configuration.",
      );
    const scanId = commitSha
      ? "scan_" + projectId + "_" + commitSha.slice(0, 32)
      : randomId("scan");
    const started = await c.env.DB.prepare(
      "UPDATE project_repositories SET status='DISCOVERING',scan_id=?,scan_progress_json=NULL,last_error=NULL,updated_at=? WHERE project_id=? AND ((?=1 AND scan_id IS ?) OR (?=0 AND (status!='DISCOVERING' OR updated_at<?))) AND (scan_id IS NULL OR scan_id!=?) RETURNING project_id",
    )
      .bind(
        scanId,
        nowIso(),
        projectId,
        commitSha ? 1 : 0,
        expectedScan ?? null,
        commitSha ? 1 : 0,
        new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        scanId,
      )
      .first();
    if (!started) {
      if (commitSha) return;
      throw conflict("DISCOVERY_RUNNING", "Repository discovery is already running.");
    }
    try {
      await c.env.REPOSITORY_DISCOVERY.create({
        id: scanId,
        params: { projectId, scanId, checks, ...(commitSha ? { commitSha } : {}) },
      });
    } catch (error) {
      await c.env.DB.prepare(
        "UPDATE project_repositories SET status='FAILED',last_error='Discovery could not be started.',updated_at=? WHERE project_id=? AND scan_id=?",
      )
        .bind(nowIso(), projectId, scanId)
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
    await startScan(c, projectId, true);
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
  routes.post("/projects/:projectId/repository/analyze", async (c) => {
    const { projectId } = await ownedProject(c);
    const b = parseWith(
      z.object({ requestId: z.string().regex(/^[A-Za-z0-9:_-]{1,140}$/) }).strict(),
      await readJsonBody(c),
      "Provide a check request ID.",
    );
    return c.json(
      data(c, await dispatchRepositoryChecks(c.env, projectId, fetcher, undefined, b.requestId)),
      202,
    );
  });
  routes.get("/projects/:projectId/repository/setup", async (c) => {
    const { projectId } = await ownedProject(c);
    return c.json(data(c, await prepareGitHubChecks(c.env, projectId, fetcher, false)));
  });
  routes.post("/projects/:projectId/repository/setup", async (c) => {
    const { projectId } = await ownedProject(c);
    return c.json(data(c, await prepareGitHubChecks(c.env, projectId, fetcher)));
  });
  routes.post("/projects/:projectId/repository/enable", async (c) => {
    const { projectId } = await ownedProject(c);
    const b = parseWith(
      z
        .object({
          prNumber: z.number().int().positive(),
          headSha: z.string().regex(/^[a-f0-9]{40}$/),
        })
        .strict(),
      await readJsonBody(c),
      "Approve the displayed setup version.",
    );
    return c.json(data(c, await approveGitHubChecks(c.env, projectId, b, fetcher)));
  });
  routes.post("/projects/:projectId/repository/run", async (c) => {
    const { projectId } = await ownedProject(c);
    return c.json(data(c, await dispatchRepositoryChecks(c.env, projectId, fetcher)), 202);
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
    if (who.source !== "local" && (b.id !== who.runId || b.sha !== (await runnerRevision(c, who))))
      throw forbidden("RUN_IDENTITY_MISMATCH", "The report does not match its assigned run.");
    const repo = await c.env.DB.prepare("SELECT * FROM project_repositories WHERE project_id=?")
      .bind(who.projectId)
      .first<RepositoryRecord>();
    if (!repo) throw notFound("Connect a repository first.");
    if (who.source === "github")
      await c.env.DB.prepare(
        "UPDATE project_repositories SET runner_enabled=1,check_setup_state='READY',check_setup_error=NULL WHERE project_id=?",
      )
        .bind(who.projectId)
        .run();
    const old = await c.env.DB.prepare("SELECT * FROM repository_jobs WHERE project_id=? AND id=?")
      .bind(who.projectId, b.id)
      .first<RepositoryJob>();
    if (old && old.source !== who.source)
      throw conflict("RUN_SOURCE_MISMATCH", "This check belongs to another runner source.");
    if (old && old.status !== "RUNNING") return c.json(data(c, { received: true }));
    if (
      b.testResults?.length &&
      (b.phase !== "test" || !["SUCCEEDED", "FAILED"].includes(b.status))
    )
      throw badRequest(
        "TEST_PHASE_REQUIRED",
        "Completed request results belong to the test phase.",
      );
    if (
      b.testResults?.some(
        (result) =>
          result.status === "SUCCEEDED" &&
          (result.checks.length === 0 ||
            result.checks.some((check) => !check.passed) ||
            !!result.error),
      )
    )
      throw badRequest(
        "TEST_VERDICT_MISMATCH",
        "A passed request result needs passing assertions and no error.",
      );
    if (b.status === "SUCCEEDED" && b.testResults?.some((result) => result.status === "FAILED"))
      throw badRequest(
        "TEST_VERDICT_MISMATCH",
        "A successful phase cannot contain a failed request test.",
      );
    const safeResults = [];
    const requestSnapshot = b.testResults?.length
      ? await c.env.DB.prepare(
          "SELECT snapshot_json FROM repository_check_requests WHERE project_id=? AND runner_id=? LIMIT 1",
        )
          .bind(who.projectId, b.id)
          .first<{ snapshot_json: string }>()
      : null;
    const snapshotCases = requestSnapshot
      ? (
          JSON.parse(requestSnapshot.snapshot_json) as {
            cases: { id: string; operationKey: string; captureResponse: boolean }[];
          }
        ).cases
      : [];
    for (const result of b.testResults ?? []) {
      const saved = await c.env.DB.prepare(
        "SELECT operation_key,config_json FROM repository_test_cases WHERE project_id=? AND id=?",
      )
        .bind(who.projectId, result.caseId)
        .first<{ operation_key: string; config_json: string }>();
      const frozen = snapshotCases.find((item) => item.id === result.caseId);
      if ((frozen?.operationKey ?? saved?.operation_key) !== result.operationKey)
        throw badRequest(
          "TEST_CASE_MISMATCH",
          "The result does not belong to a saved test in this project.",
        );
      const clean = { ...result };
      if (!(
        frozen?.captureResponse ?? (saved ? JSON.parse(saved.config_json).captureResponse : false)
      ))
        delete clean.responsePreview;
      safeResults.push(clean);
    }
    const events = (old ? JSON.parse(old.events_json) : []) as {
      phase: string;
      status: string;
      message: string;
      at: string;
    }[];
    const order = ["checkout", "discovery", "install", "build", "test", "complete"];
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
    const accepted = await c.env.DB.prepare(
      "INSERT INTO repository_jobs(id,project_id,commit_sha,source,phase,status,events_json,github_url,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET phase=excluded.phase,status=excluded.status,events_json=excluded.events_json,updated_at=excluded.updated_at WHERE repository_jobs.status='RUNNING' RETURNING id",
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
      .first();
    if (!accepted) return c.json(data(c, { received: true }));
    if (safeResults.length) {
      for (const result of safeResults)
        await c.env.DB.prepare(
          "INSERT INTO repository_test_results(project_id,check_id,case_id,trace_id,result_json,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        )
          .bind(
            who.projectId,
            b.id,
            result.caseId,
            result.traceId,
            JSON.stringify(redact(result)),
            nowIso(),
          )
          .run();
    }
    if (b.operations) {
      const prior = repo.scan_json ? JSON.parse(repo.scan_json) : { operations: [] };
      const previous = new Map<string, { sourceFlow?: unknown }>(
        (prior.operations ?? []).map((operation: { id: string; sourceFlow?: unknown }) => [
          operation.id,
          operation,
        ]),
      );
      // Older pinned runners can enrich discovery without erasing newer static
      // call relationships from the exact same immutable source revision.
      const incoming = b.operations.map((operation) => ({
        ...operation,
        sourceFlow:
          operation.sourceFlow ??
          (b.sha && repo.commit_sha === b.sha ? previous.get(operation.id)?.sourceFlow : undefined),
      }));
      const combined = [...(prior.operations ?? []), ...incoming];
      const operations = [
        ...new Map(combined.map((operation) => [operation.id, operation])).values(),
      ].slice(0, 100);
      // Runtime evidence can enrich the current successful index, never replace
      // an active/failed newer scan or roll it back to an older commit.
      await c.env.DB.prepare(
        "UPDATE project_repositories SET commit_sha=?,scan_json=?,status='DISCOVERED',last_error=NULL,updated_at=? WHERE project_id=? AND (repository_id IS NULL OR (status='DISCOVERED' AND commit_sha=?))",
      )
        .bind(
          b.sha,
          JSON.stringify({
            operations,
            filesScanned: Math.max(prior.filesScanned ?? 0, b.filesScanned ?? 0),
            warnings: b.warnings ?? [],
          }),
          nowIso(),
          who.projectId,
          b.sha,
        )
        .run();
    }
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
    if (who.source !== "local")
      for (const span of spans) {
        span.attributes["traceyard.run.id"] = who.runId;
        span.attributes["service.version"] = await runnerRevision(c, who);
      }
    await ingestSpans(c.env.DB, who.projectId, spans);
    return c.json({});
  });
  return routes;
}
