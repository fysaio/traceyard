import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { createSession, apiFetchWithGitHub, ORIGIN, readSuccess } from "./helpers";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import { dispatchRunDirectly } from "../../worker/queue/consumer";
import { callHttp, readHttpConnection } from "../../worker/integrations/http";
import { WORKFLOW_TEMPLATES } from "../../shared/workflow/templates";
import { graphSchema } from "../../shared/workflow/graph";
import type { LaunchRunResult, RunDetail } from "../../shared/contracts/api";
async function account(id = 301) {
  const user = await getOrCreateGitHubIdentity(env.DB, {
      id,
      login: "experience-" + id,
      name: "Experience account",
      avatarUrl: null,
    }),
    auth = await createUserSession(env.DB, user.id, new Request(ORIGIN));
  return {
    projectId: (await getDefaultProjectId(env.DB, user.id))!,
    cookie: (await createSession()).cookie + "; ty_auth_session=" + auth.token,
  };
}
const external: typeof fetch = async () => {
  throw Error("Unexpected external GitHub call");
};
function call(a: { cookie: string }, path: string, method = "GET", body?: unknown, token?: string) {
  return apiFetchWithGitHub(
    path,
    {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: "Bearer " + token } : {}),
        "idempotency-key": "experience-launch-001",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    external,
    a.cookie,
  );
}
describe("Project and workflow product journeys", () => {
  it("lists actual projects, creates and renames one, and protects another account", async () => {
    const a = await account(),
      b = await account(302),
      first = await readSuccess<{ items: { id: string; name: string }[] }>(
        await call(a, "/api/projects"),
      );
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.name).toBe("Main project");
    const p = await readSuccess<{ id: string }>(
      await call(a, "/api/projects", "POST", { name: "Staging" }),
    );
    expect((await call(b, "/api/projects/" + p.id, "PATCH", { name: "Takeover" })).status).toBe(
      404,
    );
    expect((await call(a, "/api/projects/" + p.id, "PATCH", { name: " " })).status).toBe(400);
    expect(
      (await call(a, "/api/projects/" + p.id, "PATCH", { name: "Customer support" })).status,
    ).toBe(200);
    const later = await readSuccess<{ items: { id: string; name: string }[] }>(
      await call(a, "/api/projects"),
    );
    expect(later.items.map((p) => p.name)).toEqual(["Main project", "Customer support"]);
    expect(
      (await readSuccess<{ items: unknown[] }>(await call(b, "/api/projects"))).items,
    ).toHaveLength(1);
  });
  it("confirms connection only after an actual authorized trace is received", async () => {
    const a = await account(),
      b = await account(302),
      base = "/api/projects/" + a.projectId;
    const before = await readSuccess<{ lastTraceReceivedAt: string | null; activeKeys: number }>(
      await call(a, base + "/connection-status"),
    );
    expect(before.lastTraceReceivedAt).toBeNull();
    const key = await readSuccess<{ token: string }>(
      await call(a, base + "/keys", "POST", { name: "My server", scopes: ["traces:write"] }),
    );
    const keyOnly = await readSuccess<{ lastTraceReceivedAt: string | null; activeKeys: number }>(
      await call(a, base + "/connection-status"),
    );
    expect(keyOnly.activeKeys).toBe(1);
    expect(keyOnly.lastTraceReceivedAt).toBeNull();
    const now = new Date().toISOString();
    expect(
      (
        await call(
          a,
          "/api/v1/traces",
          "POST",
          {
            spans: [
              {
                traceId: "1".repeat(32),
                spanId: "2".repeat(16),
                name: "First connection",
                kind: "workflow",
                status: "SUCCEEDED",
                startedAt: now,
                endedAt: now,
                attributes: { service: "My server" },
              },
            ],
          },
          key.token,
        )
      ).status,
    ).toBe(202);
    const received = await readSuccess<{ lastTraceReceivedAt: string | null; traces: number }>(
      await call(a, base + "/connection-status"),
    );
    expect(received.lastTraceReceivedAt).not.toBeNull();
    expect(received.traces).toBe(1);
    const observed = await readSuccess<{
      items: { name: string; service: string; execution_count: number }[];
    }>(await call(a, base + "/instrumented-workflows"));
    expect(observed.items[0]).toMatchObject({
      name: "First connection",
      service: "My server",
      execution_count: 1,
    });
    expect((await call(b, base + "/connection-status")).status).toBe(404);
    expect(
      (
        await readSuccess<{ traces: number }>(
          await call(b, "/api/projects/" + b.projectId + "/connection-status"),
        )
      ).traces,
    ).toBe(0);
  });
  it("creates template drafts in the selected project, retaining icon and input configuration", async () => {
    const a = await account(),
      p = await readSuccess<{ id: string }>(
        await call(a, "/api/projects", "POST", { name: "Workflow project" }),
      ),
      base = "/api/projects/" + p.id + "/studio";
    for (const t of WORKFLOW_TEMPLATES) {
      const created = await readSuccess<{ id: string }>(
        await call(a, base, "POST", { name: t.name, templateId: t.id }),
      );
      const draft = await readSuccess<{
        current_version: number;
        icon: string;
        graph: { nodes: { type: string; config: { value?: unknown } }[] };
      }>(await call(a, base + "/" + created.id));
      expect(draft.current_version).toBe(0);
      expect(draft.icon).toBe(t.icon);
      expect(draft.graph.nodes.find((n) => n.type === "input")!.config.value).toEqual(t.input);
      if (!t.setup.length) expect(graphSchema.safeParse(draft.graph).success).toBe(true);
    }
    expect(
      (
        await readSuccess<{ items: unknown[] }>(
          await call(a, "/api/projects/" + a.projectId + "/studio"),
        )
      ).items,
    ).toHaveLength(0);
    expect(
      (await call(a, base, "POST", { name: "Bad template", templateId: "made-up" })).status,
    ).toBe(400);
  });
  it("publishes and executes a template using retained real results", async () => {
    const a = await account(),
      base = "/api/projects/" + a.projectId + "/studio",
      w = await readSuccess<{ id: string }>(
        await call(a, base, "POST", { name: "Parallel processing", templateId: "parallel" }),
      );
    expect((await call(a, base + "/" + w.id + "/publish", "POST", { revision: 1 })).status).toBe(
      201,
    );
    const launch = await readSuccess<LaunchRunResult>(
      await call(a, "/api/runs", "POST", {
        workflowId: w.id,
        projectId: a.projectId,
        version: 1,
        input: { customer: { name: "Ada" }, order: { id: "order-1" } },
        scenario: "success",
      }),
    );
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, launch.run.id);
    const dispatch = await env.DB.prepare("SELECT id FROM execution_dispatches WHERE run_id=?")
      .bind(launch.run.id)
      .first<{ id: string }>();
    await dispatchRunDirectly(env, launch.run.id, dispatch!.id);
    await instance.waitForStatus("complete");
    const result = await readSuccess<RunDetail>(await call(a, "/api/runs/" + launch.run.id));
    expect(result.output).toEqual([{ name: "Ada" }, { id: "order-1" }]);
    expect(result.status).toBe("SUCCEEDED");
  });
  it("keeps incomplete model and HTTP templates as drafts requiring real configuration", async () => {
    const a = await account(),
      base = "/api/projects/" + a.projectId + "/studio";
    for (const templateId of ["document", "extraction", "research", "fallback", "sync"]) {
      const w = await readSuccess<{ id: string }>(
        await call(a, base, "POST", { name: "Needs setup", templateId }),
      );
      expect((await call(a, base + "/" + w.id + "/publish", "POST", { revision: 1 })).status).toBe(
        400,
      );
    }
  });
  it("encrypts HTTP credentials, validates destinations, snapshots connections and records actual responses", async () => {
    const a = await account(),
      b = await account(302),
      base = "/api/projects/" + a.projectId;
    expect(
      (
        await call(a, base + "/http-connections", "POST", {
          name: "Bad",
          url: "http://127.0.0.1/private",
          method: "POST",
        })
      ).status,
    ).toBe(400);
    const c = await readSuccess<{ id: string }>(
      await call(a, base + "/http-connections", "POST", {
        name: "Customer API",
        url: "https://hooks.example.test/customer",
        method: "POST",
        token: "private-http-token",
      }),
    );
    expect(await (await call(a, base + "/http-connections")).text()).not.toContain(
      "private-http-token",
    );
    expect((await call(b, base + "/http-connections")).status).toBe(404);
    const connection = await readHttpConnection(env, a.projectId, c.id),
      w = await readSuccess<{ id: string }>(
        await call(a, base + "/studio", "POST", { name: "Sync customer", templateId: "sync" }),
      );
    const draft = await readSuccess<{
      graph: { nodes: { id: string; type: string; config: Record<string, unknown> }[] };
    }>(await call(a, base + "/studio/" + w.id));
    const graph = {
      ...draft.graph,
      nodes: draft.graph.nodes.map((n) =>
        n.type === "http" ? { ...n, config: { connectionId: c.id } } : n,
      ),
    };
    await call(a, base + "/studio/" + w.id, "PUT", {
      name: "Sync customer",
      description: "",
      icon: "arrows-rotate",
      revision: 1,
      graph,
    });
    expect(
      (await call(a, base + "/studio/" + w.id + "/publish", "POST", { revision: 2 })).status,
    ).toBe(201);
    const run = await readSuccess<LaunchRunResult>(
      await call(a, "/api/runs", "POST", {
        workflowId: w.id,
        projectId: a.projectId,
        version: 1,
        input: { id: "customer-1" },
        scenario: "success",
      }),
    );
    const snapshot = await env.DB.prepare(
      "SELECT connection_json FROM run_http_connections WHERE run_id=?",
    )
      .bind(run.run.id)
      .first<{ connection_json: string }>();
    expect(JSON.parse(snapshot!.connection_json).url).toBe(connection.url);
    const result = await callHttp(
      env,
      a.projectId,
      run.run.id,
      "sync",
      connection,
      { id: "customer-1" },
      async (url, init) => {
        expect(String(url)).toBe(connection.url);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-http-token");
        expect(new Headers(init?.headers).get("idempotency-key")).toBe(run.run.id + ":sync");
        expect(init?.redirect).toBe("error");
        expect(JSON.parse(String(init?.body))).toEqual({ id: "customer-1" });
        return Response.json({ saved: true });
      },
    );
    expect(result.data).toEqual({ saved: true });
    const recorded = await env.DB.prepare(
      "SELECT status,http_status FROM http_requests WHERE run_id=?",
    )
      .bind(run.run.id)
      .first<{ status: string; http_status: number }>();
    expect(recorded).toEqual({ status: "SUCCEEDED", http_status: 200 });
  });
});
