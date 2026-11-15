import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { createSession, apiFetchWithGitHub, ORIGIN, readSuccess, apiFetch } from "./helpers";
import { createUserSession, getOrCreateGitHubIdentity } from "../../worker/persistence/identity";
import { getDefaultProjectId, createOwnedProject } from "../../worker/persistence/projects";
import { INITIAL_GRAPH } from "../../shared/workflow/graph";
import { dispatchRunDirectly } from "../../worker/queue/consumer";
import type { LaunchRunResult, RunDetail } from "../../shared/contracts/api";
async function account(id = 1) {
  const user = await getOrCreateGitHubIdentity(env.DB, {
      id,
      login: "developer-" + id,
      name: null,
      avatarUrl: null,
    }),
    session = await createUserSession(env.DB, user.id, new Request(ORIGIN));
  return {
    user,
    projectId: (await getDefaultProjectId(env.DB, user.id))!,
    cookie: (await createSession()).cookie + "; ty_auth_session=" + session.token,
  };
}
const external: typeof fetch = async () => {
  throw new Error("No external provider calls expected");
};
async function call(
  a: { cookie: string },
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
) {
  return apiFetchWithGitHub(
    path,
    {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    external,
    a.cookie,
  );
}
async function draft(a: Awaited<ReturnType<typeof account>>) {
  return readSuccess<{ id: string; revision: number }>(
    await call(a, `/api/projects/${a.projectId}/studio`, "POST", { name: "My workflow" }),
  );
}
describe("Studio publication and execution", () => {
  it("requires authentication and enforces project ownership", async () => {
    const a = await account(),
      b = await account(2);
    expect((await apiFetch(`/api/projects/${a.projectId}/studio`)).status).toBe(401);
    expect((await call(b, `/api/projects/${a.projectId}/studio`)).status).toBe(404);
  });
  it("protects draft revisions, rejects invalid publication and preserves published versions", async () => {
    const a = await account(),
      w = await draft(a),
      path = `/api/projects/${a.projectId}/studio/${w.id}`;
    const invalid = { ...INITIAL_GRAPH, edges: [] };
    expect(
      (await call(a, path, "PUT", { name: "Draft", description: "", revision: 1, graph: invalid }))
        .status,
    ).toBe(200);
    expect(
      (
        await call(a, path, "PUT", {
          name: "Overwrite",
          description: "",
          revision: 1,
          graph: INITIAL_GRAPH,
        })
      ).status,
    ).toBe(409);
    expect((await call(a, path + "/publish", "POST", { revision: 2 })).status).toBe(400);
    await call(a, path, "PUT", {
      name: "Valid",
      description: "",
      revision: 2,
      graph: INITIAL_GRAPH,
    });
    expect((await call(a, path + "/publish", "POST", { revision: 3 })).status).toBe(201);
    await call(a, path, "PUT", {
      name: "Changed draft",
      description: "",
      revision: 3,
      graph: {
        ...INITIAL_GRAPH,
        nodes: INITIAL_GRAPH.nodes.map((n) => ({ ...n, name: "Changed " + n.name })),
      },
    });
    const version = await env.DB.prepare(
      "SELECT graph_json FROM workflow_versions WHERE workflow_id = ? AND version = 1",
    )
      .bind(w.id)
      .first<{ graph_json: string }>();
    expect(JSON.parse(version!.graph_json).nodes[0].name).toBe("Input");
    expect(
      (await call(a, `/api/workflows/${w.id}?projectId=${a.projectId}&version=1`)).status,
    ).toBe(200);
  });
  it("executes the exact published graph through the real workflow binding", async () => {
    const a = await account(),
      w = await draft(a),
      path = `/api/projects/${a.projectId}/studio/${w.id}`;
    await call(a, path + "/publish", "POST", { revision: 1 });
    const secondGraph = {
      nodes: [
        INITIAL_GRAPH.nodes[0],
        {
          id: "constant",
          name: "New version output",
          type: "literal",
          config: { value: "version two" },
          x: 250,
          y: 120,
        },
        INITIAL_GRAPH.nodes[1],
      ],
      edges: [
        ["input", "constant"],
        ["constant", "output"],
      ],
    };
    expect(
      (
        await call(a, path, "PUT", {
          name: "Updated",
          description: "",
          revision: 1,
          graph: secondGraph,
        })
      ).status,
    ).toBe(200);
    expect((await call(a, path + "/publish", "POST", { revision: 2 })).status).toBe(201);
    const launch = await call(
      a,
      "/api/runs",
      "POST",
      {
        workflowId: w.id,
        projectId: a.projectId,
        version: 1,
        input: { message: "Real workflow result" },
        scenario: "success",
      },
      "graph-run-unique-01",
    );
    expect(launch.status).toBe(202);
    const bundle = await readSuccess<LaunchRunResult>(launch);
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, bundle.run.id);
    const dispatch = await env.DB.prepare("SELECT id FROM execution_dispatches WHERE run_id = ?")
      .bind(bundle.run.id)
      .first<{ id: string }>();
    await dispatchRunDirectly(env, bundle.run.id, dispatch!.id);
    await instance.waitForStatus("complete");
    const detail = await readSuccess<RunDetail>(await call(a, "/api/runs/" + bundle.run.id));
    expect(detail.status).toBe("SUCCEEDED");
    expect(detail.output).toEqual({ message: "Real workflow result" });
    expect(detail.steps.every((s) => s.status === "SUCCEEDED")).toBe(true);
  });
  it("runs independent branches and records a merged result", async () => {
    const a = await account(),
      w = await draft(a),
      path = `/api/projects/${a.projectId}/studio/${w.id}`;
    const graph = {
      nodes: [
        INITIAL_GRAPH.nodes[0],
        {
          id: "a",
          name: "First value",
          type: "literal",
          config: { value: { score: 7 } },
          x: 200,
          y: 80,
        },
        {
          id: "b",
          name: "Second value",
          type: "pick",
          config: { path: "customer.name" },
          x: 200,
          y: 250,
        },
        { id: "merge", name: "Merge results", type: "merge", config: {}, x: 450, y: 120 },
        INITIAL_GRAPH.nodes[1],
      ],
      edges: [
        ["input", "a"],
        ["input", "b"],
        ["a", "merge"],
        ["b", "merge"],
        ["merge", "output"],
      ],
    };
    expect(
      (await call(a, path, "PUT", { name: "Branches", description: "", revision: 1, graph }))
        .status,
    ).toBe(200);
    expect((await call(a, path + "/publish", "POST", { revision: 2 })).status).toBe(201);
    const launched = await call(
      a,
      "/api/runs",
      "POST",
      {
        workflowId: w.id,
        projectId: a.projectId,
        version: 1,
        input: { customer: { name: "Ada" } },
        scenario: "success",
      },
      "branched-run-key",
    );
    expect(launched.status).toBe(202);
    const bundle = await readSuccess<LaunchRunResult>(launched);
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, bundle.run.id);
    const dispatch = await env.DB.prepare("SELECT id FROM execution_dispatches WHERE run_id = ?")
      .bind(bundle.run.id)
      .first<{ id: string }>();
    await dispatchRunDirectly(env, bundle.run.id, dispatch!.id);
    await instance.waitForStatus("complete");
    const run = await readSuccess<RunDetail>(await call(a, "/api/runs/" + bundle.run.id));
    expect(run.status).toBe("SUCCEEDED");
    expect(run.output).toEqual([{ score: 7 }, "Ada"]);
    expect(run.steps).toHaveLength(5);
  });
  it("scopes run lists and idempotency requests to the selected project", async () => {
    const a = await account(),
      other = await createOwnedProject(env.DB, a.user.id, "Other");
    const input = {
      workflowId: "document-intelligence",
      projectId: a.projectId,
      version: 1,
      input: { title: "Project run", document: "This is a real document with sufficient content." },
      scenario: "success",
    };
    expect((await call(a, "/api/runs", "POST", input, "project-scope-key")).status).toBe(202);
    expect(
      (await call(a, "/api/runs", "POST", { ...input, projectId: other.id }, "project-scope-key"))
        .status,
    ).toBe(422);
    const page = await readSuccess<{ items: unknown[] }>(
      await call(a, "/api/runs?projectId=" + other.id),
    );
    expect(page.items).toHaveLength(0);
  });
});
