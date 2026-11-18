import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { apiFetch, ORIGIN, createSession, readSuccess } from "./helpers";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import type { Catalog, Operation, SavedTestCase } from "../../shared/repository/workspace";
import { discoverFile } from "../../agent/discovery.mjs";
async function account(id = 920) {
  const user = await getOrCreateGitHubIdentity(env.DB, {
      id,
      login: "workspace-" + id,
      name: "Workspace owner",
      avatarUrl: null,
    }),
    session = await createUserSession(env.DB, user.id, new Request(ORIGIN));
  return {
    cookie: (await createSession()).cookie + "; ty_auth_session=" + session.token,
    projectId: (await getDefaultProjectId(env.DB, user.id))!,
  };
}
async function call(
  a: { cookie: string },
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
) {
  return apiFetch(path, {
    method,
    headers: {
      cookie: a.cookie,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function setup() {
  const a = await account(),
    key = await readSuccess<{ token: string }>(
      await call(a, `/api/projects/${a.projectId}/keys`, "POST", {
        name: "Test runner",
        scopes: ["traces:write"],
      }),
    );
  await call(a, "/api/v1/repository/register", "POST", { name: "Application" }, key.token);
  await call(
    a,
    "/api/v1/repository-runs",
    "POST",
    {
      id: "local-setup",
      sha: "a".repeat(40),
      phase: "discovery",
      status: "SUCCEEDED",
      message: "Read source",
      operations: [
        {
          id: "route1",
          name: "GET /health",
          kind: "http",
          file: "server.ts",
          line: 1,
          calls: ["loadHealth"],
          evidence: "source",
        },
      ],
      filesScanned: 1,
      warnings: [],
    },
    key.token,
  );
  return { ...a, token: key.token };
}
describe("connected project experience", () => {
  it("serves a source flow without application keys or runtime success", async () => {
    const a = await account(),
      other = await account(921);
    const operations = discoverFile(
      "server.ts",
      `function load(){return database.read();}app.get('/health',()=>load());`,
    ).operations;
    await env.DB.prepare(
      "INSERT INTO project_repositories(project_id,full_name,status,scan_json,last_error,updated_at) VALUES(?,'Example/app','FAILED',?,'Application could not start without a provider',?)",
    )
      .bind(
        a.projectId,
        JSON.stringify({ operations, filesScanned: 1, warnings: [] }),
        new Date().toISOString(),
      )
      .run();
    const catalog = await readSuccess<Catalog>(
      await call(a, `/api/projects/${a.projectId}/catalog`),
    );
    expect(catalog.runs).toHaveLength(0);
    expect(catalog.operations[0]?.sourceFlow?.steps.map((s) => s.name)).toEqual([
      "load",
      "database.read",
    ]);
    expect(catalog.operations[0]?.evidence).toBe("source");
    const operation = await readSuccess<{ operation: Operation }>(
      await call(a, `/api/projects/${a.projectId}/operations/${catalog.operations[0]!.key}`),
    );
    expect(operation.operation.sourceFlow?.steps).toHaveLength(2);
    expect((await call(other, `/api/projects/${a.projectId}/catalog`)).status).toBe(404);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE project_id=?")
          .bind(a.projectId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it("keeps exact-revision static flows when an older runner reports without them", async () => {
    const a = await setup();
    const sourceFlow = {
      steps: [{ id: "c0", parentId: null, name: "loadHealth", line: 1, resolution: "unresolved" }],
      truncated: false,
    };
    const row = await env.DB.prepare(
      "SELECT scan_json FROM project_repositories WHERE project_id=?",
    )
      .bind(a.projectId)
      .first<{ scan_json: string }>();
    const scan = JSON.parse(row!.scan_json);
    scan.operations[0].sourceFlow = sourceFlow;
    await env.DB.prepare("UPDATE project_repositories SET scan_json=? WHERE project_id=?")
      .bind(JSON.stringify(scan), a.projectId)
      .run();
    const report = (id: string, sha: string) =>
      call(
        a,
        "/api/v1/repository-runs",
        "POST",
        {
          id,
          sha,
          phase: "discovery",
          status: "SUCCEEDED",
          message: "Older runner",
          operations: [{ ...scan.operations[0], sourceFlow: undefined }],
        },
        a.token,
      );
    expect((await report("local-compat", "a".repeat(40))).status).toBe(200);
    let catalog = await readSuccess<Catalog>(await call(a, `/api/projects/${a.projectId}/catalog`));
    expect(catalog.operations[0]?.sourceFlow).toEqual(sourceFlow);
    expect((await report("local-new-revision", "b".repeat(40))).status).toBe(200);
    catalog = await readSuccess<Catalog>(await call(a, `/api/projects/${a.projectId}/catalog`));
    expect(catalog.operations[0]?.sourceFlow).toBeUndefined();
  });
  it("links unique source routes to real runs, isolates projects and serves a complete run detail", async () => {
    const a = await setup(),
      other = await account(921);
    const span = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: null,
      name: "GET",
      kind: "workflow",
      status: "SUCCEEDED",
      startedAt: "2026-11-16T07:00:00.000Z",
      endedAt: "2026-11-16T07:00:00.050Z",
      attributes: { service: "Fixture", "http.route": "/health", "http.method": "GET" },
    };
    expect((await call(a, "/api/v1/traces", "POST", { spans: [span] }, a.token)).status).toBe(202);
    const catalog = await readSuccess<Catalog>(
      await call(a, `/api/projects/${a.projectId}/catalog`),
    );
    expect(catalog.operations).toHaveLength(1);
    expect(catalog.operations[0]).toMatchObject({
      name: "GET /health",
      evidence: "linked",
      runs: 1,
      failed: 0,
    });
    const key = catalog.operations[0]!.key;
    expect(catalog.runs[0]?.operationKey).toBe(key);
    expect((await call(other, `/api/projects/${a.projectId}/catalog`)).status).toBe(404);
    const detail = await readSuccess<{ spans: { span_id: string }[] }>(
      await call(a, `/api/projects/${a.projectId}/application-runs/${span.traceId}`),
    );
    expect(detail.spans[0]?.span_id).toBe(span.spanId);
    expect(
      (await call(other, `/api/projects/${a.projectId}/application-runs/${span.traceId}`)).status,
    ).toBe(404);
    const projects = await readSuccess<{ items: { id: string; runs: number }[] }>(
      await call(a, "/api/workspace/projects"),
    );
    expect(projects.items).toHaveLength(1);
    expect(projects.items[0]).toMatchObject({ id: a.projectId, runs: 1 });
    // A name by itself must not create a source/runtime match.
    await call(
      a,
      "/api/v1/traces",
      "POST",
      {
        spans: [
          {
            ...span,
            traceId: "c".repeat(32),
            spanId: "d".repeat(16),
            name: "GET /health",
            attributes: { service: "Unresolved service" },
          },
        ],
      },
      a.token,
    );
    const updated = await readSuccess<Catalog>(
      await call(a, `/api/projects/${a.projectId}/catalog`),
    );
    expect(updated.operations.find((o) => o.key === key)?.runs).toBe(1);
    expect(updated.operations.some((o) => o.evidence === "recorded")).toBe(true);
  });
  it("saves scoped request fixtures, validates local targets and exposes exact local runner configuration", async () => {
    const a = await setup(),
      other = await account(921),
      catalog = await readSuccess<Catalog>(await call(a, `/api/projects/${a.projectId}/catalog`)),
      op = catalog.operations[0] as Operation;
    const endpoint = `/api/projects/${a.projectId}/operations/${op.key}/cases`;
    const input = {
      name: "Health check",
      method: "GET",
      path: "/health",
      expectedStatus: 200,
      responsePath: "ready",
      expectedValue: true,
      captureResponse: false,
    };
    expect(
      (await call(a, endpoint, "POST", { ...input, path: "https://production.test" })).status,
    ).toBe(400);
    expect((await call(a, endpoint, "POST", { ...input, path: "//production.test" })).status).toBe(
      400,
    );
    expect(
      (await call(a, endpoint, "POST", { ...input, responsePath: "__proto__.x" })).status,
    ).toBe(400);
    const saved = await readSuccess<SavedTestCase>(await call(a, endpoint, "POST", input));
    expect((await call(other, endpoint, "POST", input)).status).toBe(404);
    expect(
      (
        await call(a, `/api/projects/${a.projectId}/operations/${op.key}/test`, "POST", {
          caseId: saved.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(a, `/api/projects/${a.projectId}/runner-config`, "PUT", {
          directory: "../secrets",
          startScript: "start",
          port: 3000,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(a, `/api/projects/${a.projectId}/runner-config`, "PUT", {
          directory: ".",
          startScript: "start:test",
          port: 3100,
        })
      ).status,
    ).toBe(200);
    const manifest = await readSuccess<{ config: { startScript: string }; cases: SavedTestCase[] }>(
      await call(
        a,
        "/api/v1/repository/configuration?case=" + saved.id + "&run=local-result",
        "GET",
        undefined,
        a.token,
      ),
    );
    expect(manifest.config.startScript).toBe("start:test");
    expect(manifest.cases[0]).toMatchObject({ id: saved.id, expectedValue: true });
    expect(
      (await call(other, `/api/projects/${a.projectId}/cases/${saved.id}`, "DELETE")).status,
    ).toBe(404);
    expect((await call(a, `/api/projects/${a.projectId}/cases/${saved.id}`, "DELETE")).status).toBe(
      200,
    );
    const outcome = {
      caseId: saved.id,
      name: saved.name,
      operationKey: op.key,
      traceId: "e".repeat(32),
      status: "SUCCEEDED",
      durationMs: 20,
      responseStatus: 200,
      checks: [{ name: "HTTP status is 200", passed: true }],
      responsePreview: "Should not be saved without opt-in",
    };
    const report = {
      id: "local-result",
      sha: "a".repeat(40),
      phase: "test",
      status: "SUCCEEDED",
      message: "Request completed",
      testResults: [outcome],
    };
    expect((await call(a, "/api/v1/repository-runs", "POST", report, a.token)).status).toBe(200);
    const stored = await env.DB.prepare(
      "SELECT result_json FROM repository_test_results WHERE project_id=? AND check_id='local-result'",
    )
      .bind(a.projectId)
      .first<{ result_json: string }>();
    expect(JSON.parse(stored!.result_json).responsePreview).toBeUndefined();
    expect(
      (
        await call(
          a,
          "/api/v1/repository-runs",
          "POST",
          { ...report, id: "local-inconsistent", testResults: [{ ...outcome, status: "FAILED" }] },
          a.token,
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await call(
          a,
          "/api/v1/repository-runs",
          "POST",
          {
            ...report,
            id: "local-bad",
            testResults: [{ ...outcome, caseId: "another-project-case" }],
          },
          a.token,
        )
      ).status,
    ).toBe(400);
  });
});

it("refuses old executors before exposing a focused plan, rather than running an ordinary full suite", async () => {
  const a = await setup();
  const inv = await readSuccess<{ id: string }>(
    await call(a, `/api/projects/${a.projectId}/investigations`, "POST", {
      question: "Inspect an existing failure",
    }),
  );
  const requestId = "req_" + "e".repeat(32);
  await env.DB.prepare("UPDATE investigations SET status='EXECUTING' WHERE id=?")
    .bind(inv.id)
    .run();
  await env.DB.prepare(
    "INSERT INTO repository_check_requests(id,project_id,snapshot_json,created_at) VALUES(?,?,?,?)",
  )
    .bind(
      requestId,
      a.projectId,
      JSON.stringify({
        config: { directory: ".", startScript: "", port: 3000 },
        cases: [],
        investigation: {
          investigationId: inv.id,
          requestId,
          question: "Inspect an existing failure",
          commit: null,
          timeoutMs: 120000,
        },
      }),
      new Date().toISOString(),
    )
    .run();
  const path = "/api/v1/repository/configuration?request=" + requestId + "&run=local-protocol";
  expect((await call(a, path, "GET", undefined, a.token)).status).toBe(409);
  const accepted = await apiFetch(path, {
    headers: {
      cookie: a.cookie,
      Authorization: "Bearer " + a.token,
      "X-Traceyard-Runner-Protocol": "2",
    },
  });
  expect(accepted.status).toBe(200);
  expect(
    ((await accepted.json()) as { data: { investigation: { requestId: string } } }).data
      .investigation.requestId,
  ).toBe(requestId);
});
