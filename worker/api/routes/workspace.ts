import { redact } from "../../../shared/contracts/traces";
import { Hono } from "hono";
import { z } from "zod";
import {
  runnerConfigSchema,
  testCaseSchema,
  type SavedTestCase,
  type TestResult,
} from "../../../shared/repository/workspace";
import { ownedProject } from "../../integrations/access";
import { getRequestContext, readJsonBody, type AppEnv } from "../middleware";
import { badRequest, notFound, parseWith, unauthorized } from "../errors";
import { projectCatalog, applicationRuns } from "../../repositories/catalog";
import { runnerPrincipal } from "../../repositories/runner-auth";
import { installationOwned, githubRequest } from "../../repositories/github";
import { upgradeRepositoryChecks, dispatchRepositoryChecks } from "../../repositories/checks";
import { randomId } from "../../lib/crypto";
import { nowIso } from "../../lib/time";
import type { RepositoryRecord } from "../../../shared/repository/contracts";
export function workspaceRoutes(fetcher: typeof fetch = fetch) {
  const app = new Hono<AppEnv>();
  const data = (c: Parameters<typeof getRequestContext>[0], value: unknown) => ({
    data: value,
    meta: { requestId: getRequestContext(c).requestId },
  });
  app.get("/workspace/projects", async (c) => {
    const auth = c.get("auth");
    if (!auth) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to view projects.");
    const projects = await c.env.DB.prepare(
      `SELECT p.id,p.name,p.created_at AS createdAt,r.full_name AS repository,r.status AS discoveryStatus,r.check_setup_state AS setupState,
    (SELECT COUNT(DISTINCT trace_id) FROM trace_spans WHERE project_id=p.id) AS runs,
    (SELECT COUNT(DISTINCT trace_id) FROM trace_spans WHERE project_id=p.id AND parent_span_id IS NULL AND status='FAILED') AS failed,
    (SELECT MAX(started_at) FROM trace_spans WHERE project_id=p.id) AS lastRunAt,
    (SELECT status FROM repository_jobs WHERE project_id=p.id ORDER BY updated_at DESC LIMIT 1) AS lastCheck
    FROM projects p LEFT JOIN project_repositories r ON r.project_id=p.id WHERE p.owner_user_id=? ORDER BY p.created_at DESC`,
    )
      .bind(auth.user.id)
      .all();
    return c.json(data(c, { items: projects.results }));
  });
  app.post("/projects/:projectId/repository/upgrade", async (c) => {
    const { projectId } = await ownedProject(c);
    return c.json(data(c, await upgradeRepositoryChecks(c.env, projectId, fetcher)));
  });
  app.post("/projects/:projectId/checks/:id/cancel", async (c) => {
    const { projectId, userId } = await ownedProject(c),
      job = await c.env.DB.prepare("SELECT * FROM repository_jobs WHERE project_id=? AND id=?")
        .bind(projectId, c.req.param("id"))
        .first<{ id: string; status: string; source: string }>();
    const repo = await c.env.DB.prepare("SELECT * FROM project_repositories WHERE project_id=?")
      .bind(projectId)
      .first<RepositoryRecord>();
    if (
      !job ||
      job.source !== "github" ||
      !/^\d+-\d+$/.test(job.id) ||
      !repo?.installation_id ||
      !(await installationOwned(c.env.DB, userId, repo.installation_id))
    )
      throw notFound("GitHub check not found.");
    if (job.status !== "RUNNING")
      throw badRequest("CHECK_FINISHED", "This check has already finished.");
    await githubRequest(
      c.env,
      repo.installation_id,
      `/repos/${repo.full_name}/actions/runs/${job.id.split("-")[0]}/cancel`,
      { method: "POST" },
      fetcher,
    );
    return c.json(data(c, { requested: true }), 202);
  });
  app.get("/projects/:projectId/catalog", async (c) => {
    const { userId, projectId } = await ownedProject(c);
    return c.json(data(c, await projectCatalog(c.env, userId, projectId)));
  });
  app.get("/projects/:projectId/operations/:key", async (c) => {
    const { userId, projectId } = await ownedProject(c),
      catalog = await projectCatalog(c.env, userId, projectId),
      operation = catalog.operations.find((o) => o.key === c.req.param("key"));
    if (!operation) throw notFound("Operation not found in the current source or recent runs.");
    const cases = await c.env.DB.prepare(
      "SELECT * FROM repository_test_cases WHERE project_id=? AND operation_key=? ORDER BY updated_at DESC",
    )
      .bind(projectId, operation.key)
      .all<{ id: string; operation_key: string; config_json: string; updated_at: string }>();
    return c.json(
      data(c, {
        ...catalog,
        operation,
        runs: catalog.runs.filter((r) => r.operationKey === operation.key),
        cases: cases.results.map((r) => ({
          id: r.id,
          operationKey: r.operation_key,
          updatedAt: r.updated_at,
          ...JSON.parse(r.config_json),
        })),
      }),
    );
  });
  app.put("/projects/:projectId/runner-config", async (c) => {
    const { projectId } = await ownedProject(c),
      config = parseWith(
        runnerConfigSchema,
        await readJsonBody(c),
        "Check the application settings.",
      );
    await c.env.DB.prepare(
      "INSERT INTO repository_runner_configs(project_id,config_json,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at",
    )
      .bind(projectId, JSON.stringify(config), nowIso())
      .run();
    return c.json(data(c, config));
  });
  app.post("/projects/:projectId/operations/:key/cases", async (c) => {
    const { userId, projectId } = await ownedProject(c),
      catalog = await projectCatalog(c.env, userId, projectId),
      operation = catalog.operations.find((o) => o.key === c.req.param("key"));
    if (!operation || operation.kind !== "http" || !operation.file)
      throw badRequest(
        "HTTP_OPERATION_REQUIRED",
        "Choose a discovered HTTP operation to save a request test.",
      );
    const input = parseWith(testCaseSchema, await readJsonBody(c), "Check the test input.");
    if (JSON.stringify(input).length > 10000)
      throw badRequest("TEST_INPUT_TOO_LARGE", "Test fixtures are limited to 10 KB.");
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM repository_test_cases WHERE project_id=?",
    )
      .bind(projectId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= 30)
      throw badRequest("CASE_LIMIT", "A project can have up to 30 saved request tests.");
    const result: SavedTestCase = {
      ...input,
      id: randomId("case"),
      operationKey: operation.key,
      updatedAt: nowIso(),
    };
    await c.env.DB.prepare(
      "INSERT INTO repository_test_cases(id,project_id,operation_key,config_json,updated_at) VALUES(?,?,?,?,?)",
    )
      .bind(result.id, projectId, operation.key, JSON.stringify(input), result.updatedAt)
      .run();
    return c.json(data(c, result), 201);
  });
  app.delete("/projects/:projectId/cases/:caseId", async (c) => {
    const { projectId } = await ownedProject(c);
    const deleted = await c.env.DB.prepare(
      "DELETE FROM repository_test_cases WHERE project_id=? AND id=? RETURNING id",
    )
      .bind(projectId, c.req.param("caseId"))
      .first();
    if (!deleted) throw notFound("Test case not found.");
    return c.json(data(c, { deleted: true }));
  });
  app.post("/projects/:projectId/operations/:key/test", async (c) => {
    const { projectId } = await ownedProject(c),
      body = parseWith(
        z.object({ caseId: z.string().max(100) }).strict(),
        await readJsonBody(c),
        "Choose a saved test.",
      );
    const saved = await c.env.DB.prepare(
      "SELECT * FROM repository_test_cases WHERE project_id=? AND operation_key=? AND id=?",
    )
      .bind(projectId, c.req.param("key"), body.caseId)
      .first<{ id: string; operation_key: string; config_json: string }>();
    if (!saved) throw notFound("Saved test not found.");
    const row = await c.env.DB.prepare(
      "SELECT config_json FROM repository_runner_configs WHERE project_id=?",
    )
      .bind(projectId)
      .first<{ config_json: string }>();
    const config = runnerConfigSchema.parse(row ? JSON.parse(row.config_json) : {});
    if (!config.startScript)
      throw badRequest(
        "START_SCRIPT_REQUIRED",
        "Set the application startup script under Test settings first.",
      );
    const id = randomId("req");
    await c.env.DB.prepare(
      "INSERT INTO repository_check_requests(id,project_id,snapshot_json,created_at) VALUES(?,?,?,?)",
    )
      .bind(
        id,
        projectId,
        JSON.stringify({
          config,
          cases: [
            { id: saved.id, operationKey: saved.operation_key, ...JSON.parse(saved.config_json) },
          ],
        }),
        nowIso(),
      )
      .run();
    try {
      const result = await dispatchRepositoryChecks(c.env, projectId, fetcher, id);
      return c.json(data(c, { ...result, requestId: id }), 202);
    } catch (error) {
      await c.env.DB.prepare(
        "DELETE FROM repository_check_requests WHERE id=? AND runner_id IS NULL",
      )
        .bind(id)
        .run();
      throw error;
    }
  });
  app.get("/projects/:projectId/application-runs/:traceId", async (c) => {
    const { projectId } = await ownedProject(c),
      id = c.req.param("traceId");
    const spans = await c.env.DB.prepare(
      "SELECT trace_id,span_id,parent_span_id,name,kind,status,started_at,ended_at,attributes_json,input_json,output_json,error_json FROM trace_spans WHERE project_id=? AND trace_id=? ORDER BY started_at,span_id",
    )
      .bind(projectId, id)
      .all();
    if (!spans.results.length) throw notFound("Run not found.");
    const results = await c.env.DB.prepare(
      "SELECT result_json,check_id FROM repository_test_results WHERE project_id=? AND trace_id=?",
    )
      .bind(projectId, id)
      .all<{ result_json: string; check_id: string }>();
    return c.json(
      data(c, {
        spans: spans.results,
        tests: await Promise.all(
          results.results.map(async (r) => {
            const result = JSON.parse(r.result_json) as TestResult;
            const snapshot = await c.env.DB.prepare(
              "SELECT snapshot_json FROM repository_check_requests WHERE project_id=? AND runner_id=? LIMIT 1",
            )
              .bind(projectId, r.check_id)
              .first<{ snapshot_json: string }>();
            const request = snapshot
              ? (JSON.parse(snapshot.snapshot_json) as { cases: SavedTestCase[] }).cases.find(
                  (item) => item.id === result.caseId,
                )
              : null;
            return {
              ...result,
              checkId: r.check_id,
              ...(request
                ? {
                    request: redact({
                      method: request.method,
                      path: request.path,
                      body: request.body,
                      expectedStatus: request.expectedStatus,
                      responsePath: request.responsePath,
                      expectedValue: request.expectedValue,
                    }),
                  }
                : {}),
            };
          }),
        ),
      }),
    );
  });
  app.get("/projects/:projectId/run-history", async (c) => {
    const { projectId } = await ownedProject(c);
    return c.json(data(c, { items: await applicationRuns(c.env.DB, projectId, 500) }));
  });
  app.get("/v1/repository/configuration", async (c) => {
    const who = await runnerPrincipal(c, fetcher),
      requestId = c.req.query("request");
    if (requestId) {
      const row = await c.env.DB.prepare(
        "SELECT snapshot_json,runner_id FROM repository_check_requests WHERE id=? AND project_id=? AND created_at>?",
      )
        .bind(requestId, who.projectId, new Date(Date.now() - 30 * 60000).toISOString())
        .first<{ snapshot_json: string; runner_id: string | null }>();
      if (!row || who.source !== "github") throw notFound("Check request not found or expired.");
      const bound = await c.env.DB.prepare(
        "UPDATE repository_check_requests SET runner_id=? WHERE id=? AND project_id=? AND (runner_id IS NULL OR runner_id=?) RETURNING id",
      )
        .bind(who.runId, requestId, who.projectId, who.runId)
        .first();
      if (!bound)
        throw badRequest("REQUEST_ALREADY_BOUND", "This test request belongs to another run.");
      return c.json(data(c, JSON.parse(row.snapshot_json)));
    }
    const config = await c.env.DB.prepare(
      "SELECT config_json FROM repository_runner_configs WHERE project_id=?",
    )
      .bind(who.projectId)
      .first<{ config_json: string }>();
    const caseId = c.req.query("case");
    let cases: SavedTestCase[] = [];
    if (caseId && who.source === "local") {
      const saved = await c.env.DB.prepare(
        "SELECT * FROM repository_test_cases WHERE project_id=? AND id=?",
      )
        .bind(who.projectId, caseId)
        .first<{ id: string; operation_key: string; config_json: string; updated_at: string }>();
      if (!saved) throw notFound("Saved test not found.");
      cases = [
        {
          id: saved.id,
          operationKey: saved.operation_key,
          updatedAt: saved.updated_at,
          ...JSON.parse(saved.config_json),
        },
      ];
    }
    const manifest = {
      config: runnerConfigSchema.parse(config ? JSON.parse(config.config_json) : {}),
      cases,
    };
    const localRun = c.req.query("run");
    if (
      cases.length &&
      who.source === "local" &&
      /^local-[A-Za-z0-9_-]{1,90}$/.test(localRun ?? "")
    )
      await c.env.DB.prepare(
        "INSERT INTO repository_check_requests(id,project_id,snapshot_json,runner_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
        .bind(localRun, who.projectId, JSON.stringify(manifest), localRun, nowIso())
        .run();
    return c.json(data(c, manifest));
  });
  // Check-result metadata stays separate from automatic span payload capture.
  app.get("/projects/:projectId/checks/:id", async (c) => {
    const { projectId } = await ownedProject(c),
      job = await c.env.DB.prepare("SELECT * FROM repository_jobs WHERE project_id=? AND id=?")
        .bind(projectId, c.req.param("id"))
        .first();
    if (!job) throw notFound("Check not found.");
    const results = await c.env.DB.prepare(
      "SELECT result_json FROM repository_test_results WHERE project_id=? AND check_id=?",
    )
      .bind(projectId, c.req.param("id"))
      .all<{ result_json: string }>();
    const repo = await c.env.DB.prepare(
      "SELECT full_name,repository_id FROM project_repositories WHERE project_id=?",
    )
      .bind(projectId)
      .first<Pick<RepositoryRecord, "full_name" | "repository_id">>();
    return c.json(
      data(c, {
        job,
        tests: results.results.map((r) => JSON.parse(r.result_json)),
        repository: repo,
      }),
    );
  });
  return app;
}
