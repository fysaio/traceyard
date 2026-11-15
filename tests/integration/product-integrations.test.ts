import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, introspectWorkflowInstance } from "cloudflare:test";
import { createApp } from "../../worker/api/app";
import { createUserSession, getOrCreateGitHubIdentity } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import { createSession, ORIGIN, readSuccess, VALID_INPUT } from "./helpers";
import { encryptSecret, decryptSecret } from "../../worker/integrations/secrets";
import { callModel } from "../../worker/integrations/gateway";
import { runIntegrationJobs } from "../../worker/jobs/integrations";
import { dispatchRunDirectly } from "../../worker/queue/consumer";
import { INITIAL_GRAPH } from "../../shared/workflow/graph";
import { sha256Hex } from "../../worker/lib/crypto";
import { isoFromNow, nowIso } from "../../worker/lib/time";
import type { LaunchRunResult, RunDetail } from "../../shared/contracts/api";
async function account(id = 1) {
  const user = await getOrCreateGitHubIdentity(env.DB, {
      id,
      login: "owner-" + id,
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
function call(
  a: { cookie: string } | null,
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
) {
  return createApp().fetch(
    new Request(ORIGIN + path, {
      method,
      headers: {
        origin: ORIGIN,
        ...(a ? { cookie: a.cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: "Bearer " + token } : {}),
        "idempotency-key": "integration-key-00001",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    createExecutionContext(),
  );
}
async function key(a: Awaited<ReturnType<typeof account>>, scopes = ["traces:write"]) {
  return readSuccess<{ id: string; token: string }>(
    await call(a, `/api/projects/${a.projectId}/keys`, "POST", { name: "Server", scopes }),
  );
}
const span = {
  traceId: "a".repeat(32),
  spanId: "1".repeat(16),
  name: "Root",
  status: "RUNNING",
  startedAt: nowIso(),
  attributes: { authorization: "secret", label: "Bearer test-secret", nested: { apiKey: "value" } },
};
async function createGraph(a: Awaited<ReturnType<typeof account>>, type = "approval") {
  const base = `/api/projects/${a.projectId}/studio`,
    w = await readSuccess<{ id: string }>(await call(a, base, "POST", { name: "Review flow" }));
  await call(a, base + "/" + w.id, "PUT", {
    name: "Review flow",
    description: "",
    revision: 1,
    graph: {
      nodes: [
        INITIAL_GRAPH.nodes[0],
        {
          id: "review",
          name: "Review",
          type,
          config:
            type === "approval"
              ? { prompt: "Approve this", expiresMinutes: 1 }
              : { limit: 3, path: "name" },
          x: 300,
          y: 120,
        },
        INITIAL_GRAPH.nodes[1],
      ],
      edges: [
        ["input", "review"],
        ["review", "output"],
      ],
    },
  });
  expect((await call(a, base + "/" + w.id + "/publish", "POST", { revision: 2 })).status).toBe(201);
  return w.id;
}
async function launch(a: Awaited<ReturnType<typeof account>>, workflowId: string, input: unknown) {
  const r = await call(a, "/api/runs", "POST", {
    workflowId,
    projectId: a.projectId,
    version: 1,
    input,
    scenario: "success",
  });
  expect(r.status).toBe(202);
  return readSuccess<LaunchRunResult>(r);
}
describe("Scoped integrations", () => {
  it("hashes one-time keys, denies other owners and enforces scopes/revocation", async () => {
    const a = await account(),
      b = await account(2),
      k = await key(a);
    const row = await env.DB.prepare("SELECT token_hash FROM api_keys WHERE id=?")
      .bind(k.id)
      .first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await sha256Hex(k.token));
    const listed = await call(a, `/api/projects/${a.projectId}/keys`);
    expect(await listed.text()).not.toContain(k.token);
    expect((await call(b, `/api/projects/${a.projectId}/keys`)).status).toBe(404);
    expect((await call(null, "/api/v1/runs", "GET", undefined, k.token)).status).toBe(403);
    expect((await call(null, "/api/v1/traces", "POST", { spans: [span] }, k.token)).status).toBe(
      202,
    );
    await call(a, `/api/projects/${a.projectId}/keys/${k.id}/revoke`, "POST");
    expect((await call(null, "/api/v1/traces", "POST", { spans: [span] }, k.token)).status).toBe(
      401,
    );
  });
  it("redacts nested attributes, completes spans once and rejects parent cycles", async () => {
    const a = await account(),
      k = await key(a);
    await call(null, "/api/v1/traces", "POST", { spans: [span] }, k.token);
    await call(
      null,
      "/api/v1/traces",
      "POST",
      {
        spans: [
          {
            ...span,
            status: "SUCCEEDED",
            endedAt: nowIso(),
            output: { password: "hidden", result: 4 },
          },
        ],
      },
      k.token,
    );
    await call(
      null,
      "/api/v1/traces",
      "POST",
      { spans: [{ ...span, status: "FAILED", endedAt: nowIso(), output: "overwrite" }] },
      k.token,
    );
    const d = await readSuccess<{
      items: { attributes_json: string; output_json: string; status: string }[];
    }>(await call(a, `/api/projects/${a.projectId}/traces/${span.traceId}`));
    expect(d.items[0]!.status).toBe("SUCCEEDED");
    expect(JSON.parse(d.items[0]!.output_json)).toEqual({ password: "[redacted]", result: 4 });
    expect(d.items[0]!.attributes_json).not.toContain("test-secret");
    const cycle = { ...span, traceId: "b".repeat(32), parentSpanId: "2".repeat(16) };
    await call(null, "/api/v1/traces", "POST", { spans: [cycle] }, k.token);
    expect(
      (
        await call(
          null,
          "/api/v1/traces",
          "POST",
          { spans: [{ ...cycle, spanId: "2".repeat(16), parentSpanId: span.spanId }] },
          k.token,
        )
      ).status,
    ).toBe(409);
  });
  it("limits key requests atomically and isolates execution triggers", async () => {
    const a = await account(),
      b = await account(2),
      k = await key(a, ["runs:read", "runs:write"]);
    expect(
      (
        await call(
          null,
          "/api/v1/runs",
          "POST",
          {
            workflowId: "document-intelligence",
            projectId: b.projectId,
            input: VALID_INPUT,
            scenario: "success",
          },
          k.token,
        )
      ).status,
    ).toBe(404);
    const first = await readSuccess<LaunchRunResult>(
        await call(
          null,
          "/api/v1/runs",
          "POST",
          { workflowId: "document-intelligence", input: VALID_INPUT, scenario: "success" },
          k.token,
        ),
      ),
      second = await readSuccess<LaunchRunResult>(
        await call(
          null,
          "/api/v1/runs",
          "POST",
          { workflowId: "document-intelligence", input: VALID_INPUT, scenario: "success" },
          k.token,
        ),
      );
    expect(first.run.id).toBe(second.run.id);
    await env.DB.prepare("UPDATE api_request_limits SET count=120 WHERE key_id=?").bind(k.id).run();
    expect((await call(null, "/api/v1/runs", "GET", undefined, k.token)).status).toBe(429);
  });
  it("encrypts credentials with project binding and calls fallback only on transient failure", async () => {
    const a = await account(),
      value = await encryptSecret(env, "credential", a.projectId);
    expect(value).not.toContain("credential");
    expect(await decryptSecret(env, value, a.projectId)).toBe("credential");
    await expect(decryptSecret(env, value, "other")).rejects.toThrow();
    for (const provider of ["groq", "openai"])
      expect(
        (
          await call(a, `/api/projects/${a.projectId}/gateway/credentials/${provider}`, "PUT", {
            apiKey: "test-key-only",
          })
        ).status,
      ).toBe(200);
    const route = await readSuccess<{ id: string }>(
      await call(a, `/api/projects/${a.projectId}/gateway/routes`, "POST", {
        name: "Fallback",
        models: [
          { provider: "groq", model: "first" },
          {
            provider: "openai",
            model: "second",
            inputPricePerMillion: 1,
            outputPricePerMillion: 2,
          },
        ],
        timeoutMs: 1000,
        maxTokens: 30,
      }),
    );
    let attempts = 0;
    const result = await callModel(env, a.projectId, route.id, "Hello", {}, async (input, init) => {
      attempts++;
      expect(init?.redirect).toBe("error");
      if (String(input).includes("groq")) return new Response("{}", { status: 503 });
      return Response.json({
        choices: [{ message: { content: "real response" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      });
    });
    expect(attempts).toBe(2);
    expect(result.text).toBe("real response");
    expect(result.estimatedCostUsd).toBe(0.000011);
    expect(result.attempts).toHaveLength(2);
    let permanent = 0;
    await expect(
      callModel(env, a.projectId, route.id, "Bad", {}, async () => {
        permanent++;
        return new Response("{}", { status: 401 });
      }),
    ).rejects.toThrow("HTTP 401");
    expect(permanent).toBe(1);
    const publicData = await call(a, `/api/projects/${a.projectId}/gateway`);
    expect(await publicData.text()).not.toContain("test-key-only");
  });
  it("waits for an authorized approval then resumes the durable graph exactly once", async () => {
    const a = await account(),
      b = await account(2),
      workflow = await createGraph(a),
      bundle = await launch(a, workflow, { review: "data" });
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, bundle.run.id);
    const dispatch = await env.DB.prepare("SELECT id FROM execution_dispatches WHERE run_id=?")
      .bind(bundle.run.id)
      .first<{ id: string }>();
    await dispatchRunDirectly(env, bundle.run.id, dispatch!.id);
    const id = (await instance.waitForStepResult({ name: "review-approval-create" })) as string;
    expect(
      (
        await call(b, `/api/projects/${a.projectId}/approvals/${id}/decision`, "POST", {
          decision: "APPROVED",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(a, `/api/projects/${a.projectId}/approvals/${id}/decision`, "POST", {
          decision: "APPROVED",
          note: "Checked",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(a, `/api/projects/${a.projectId}/approvals/${id}/decision`, "POST", {
          decision: "REJECTED",
        })
      ).status,
    ).toBe(409);
    await instance.modify((m) => m.disableSleeps());
    await instance.waitForStatus("complete");
    const detail = await readSuccess<RunDetail>(await call(a, "/api/runs/" + bundle.run.id));
    expect(detail.status).toBe("SUCCEEDED");
    expect(detail.output).toEqual({ review: "data" });
  });
  it("runs bounded map operations through published execution", async () => {
    const a = await account(),
      workflow = await createGraph(a, "map"),
      bundle = await launch(a, workflow, [{ name: "Ada" }, { name: "Grace" }]);
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, bundle.run.id);
    const dispatch = await env.DB.prepare("SELECT id FROM execution_dispatches WHERE run_id=?")
      .bind(bundle.run.id)
      .first<{ id: string }>();
    await dispatchRunDirectly(env, bundle.run.id, dispatch!.id);
    await instance.waitForStatus("complete");
    const detail = await readSuccess<RunDetail>(await call(a, "/api/runs/" + bundle.run.id));
    expect(detail.output).toEqual(["Ada", "Grace"]);
  });
  it("persists repeat groups and computes assertions from real execution evidence", async () => {
    const a = await account(),
      id = await createGraph(a, "map");
    const e = await readSuccess<{ id: string }>(
      await call(a, `/api/projects/${a.projectId}/experiments`, "POST", {
        name: "Expected names",
        config: {
          workflowId: id,
          version: 1,
          input: [{ name: "Ada" }],
          repetitions: 2,
          scenario: "success",
          expectedStatus: "SUCCEEDED",
          outputPath: "0",
          expectedValue: "Ada",
        },
      }),
    );
    const path = `/api/projects/${a.projectId}/experiments/${e.id}/launch`,
      r = await readSuccess<{ runIds: string[] }>(await call(a, path, "POST"));
    const duplicate = await readSuccess<{ runIds: string[] }>(await call(a, path, "POST"));
    expect(duplicate.runIds).toEqual(r.runIds);
    expect(r.runIds).toHaveLength(2);
    for (const runId of r.runIds) {
      await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, runId);
      const dispatch = await env.DB.prepare("SELECT id FROM execution_dispatches WHERE run_id=?")
        .bind(runId)
        .first<{ id: string }>();
      await dispatchRunDirectly(env, runId, dispatch!.id);
      await instance.waitForStatus("complete");
    }
    const result = await readSuccess<{ items: { runs: { verdict: { status: string } }[] }[] }>(
      await call(a, `/api/projects/${a.projectId}/experiments`),
    );
    expect(result.items[0]!.runs.every((r) => r.verdict.status === "PASSED")).toBe(true);
  });
  it("dispatches schedules idempotently and signs retried webhook deliveries", async () => {
    const a = await account(),
      base = `/api/projects/${a.projectId}`;
    expect(
      (
        await call(a, base + "/webhooks", "POST", {
          url: "http://127.0.0.1/private",
          signingSecret: "a".repeat(24),
        })
      ).status,
    ).toBe(400);
    const schedule = await readSuccess<{ id: string }>(
      await call(a, base + "/schedules", "POST", {
        workflowId: "document-intelligence",
        version: 1,
        input: VALID_INPUT,
        intervalMinutes: 5,
      }),
    );
    await env.DB.prepare("UPDATE workflow_schedules SET next_run_at=? WHERE id=?")
      .bind(isoFromNow(-60000), schedule.id)
      .run();
    await runIntegrationJobs(env);
    await runIntegrationJobs(env);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduled_dispatches WHERE schedule_id=?")
        .bind(schedule.id)
        .first<{ n: number }>())!.n,
    ).toBe(1);
    const hook = await readSuccess<{ id: string }>(
      await call(a, base + "/webhooks", "POST", {
        url: "https://hooks.example.test/completed",
        signingSecret: "signing-secret-for-test-only",
      }),
    );
    const bundle = await launch(a, "document-intelligence", VALID_INPUT);
    await env.DB.prepare("UPDATE runs SET status='SUCCEEDED',completed_at=? WHERE id=?")
      .bind(nowIso(), bundle.run.id)
      .run();
    let signed = false;
    await runIntegrationJobs(env, async (_url, init) => {
      const h = new Headers(init?.headers);
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("signing-secret-for-test-only"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const hex = h.get("x-traceyard-signature")!.slice(7),
        signature = Uint8Array.from(hex.match(/../gu)!, (v) => parseInt(v, 16));
      signed = await crypto.subtle.verify(
        "HMAC",
        key,
        signature,
        new TextEncoder().encode(h.get("x-traceyard-timestamp") + "." + init?.body),
      );
      return new Response(null, { status: 503 });
    });
    expect(signed).toBe(true);
    const delivery = await env.DB.prepare(
      "SELECT id,attempts,status FROM webhook_deliveries WHERE webhook_id=?",
    )
      .bind(hook.id)
      .first<{ id: string; attempts: number; status: string }>();
    expect(delivery!.attempts).toBe(1);
    expect(delivery!.status).toBe("PENDING");
    await env.DB.prepare("UPDATE webhook_deliveries SET next_attempt_at=? WHERE id=?")
      .bind(isoFromNow(-1000), delivery!.id)
      .run();
    await runIntegrationJobs(env, async () => new Response(null, { status: 204 }));
    expect(
      (await env.DB.prepare("SELECT status FROM webhook_deliveries WHERE id=?")
        .bind(delivery!.id)
        .first<{ status: string }>())!.status,
    ).toBe("SUCCEEDED");
  });
  it("skips the unselected condition path and preserves attempt payload evidence", async () => {
    const a = await account(),
      base = `/api/projects/${a.projectId}/studio`,
      w = await readSuccess<{ id: string }>(await call(a, base, "POST", { name: "Conditional" }));
    const graph = {
      nodes: [
        INITIAL_GRAPH.nodes[0],
        {
          id: "branch",
          name: "Choose",
          type: "condition",
          config: { path: "approved", equals: true, thenTarget: "yes", elseTarget: "no" },
          x: 300,
          y: 120,
        },
        {
          id: "yes",
          name: "Accepted",
          type: "literal",
          config: { value: "accepted" },
          x: 550,
          y: 60,
        },
        { id: "no", name: "Must not execute", type: "map", config: { limit: 1 }, x: 550, y: 250 },
        { id: "join", name: "Join", type: "merge", config: {}, x: 800, y: 120 },
        INITIAL_GRAPH.nodes[1],
      ],
      edges: [
        ["input", "branch"],
        ["branch", "yes"],
        ["branch", "no"],
        ["yes", "join"],
        ["no", "join"],
        ["join", "output"],
      ],
    };
    expect(
      (
        await call(a, base + "/" + w.id, "PUT", {
          name: "Conditional",
          description: "",
          revision: 1,
          graph,
        })
      ).status,
    ).toBe(200);
    expect((await call(a, base + "/" + w.id + "/publish", "POST", { revision: 2 })).status).toBe(
      201,
    );
    const bundle = await launch(a, w.id, { approved: true });
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, bundle.run.id);
    const dispatch = await env.DB.prepare("SELECT id FROM execution_dispatches WHERE run_id=?")
      .bind(bundle.run.id)
      .first<{ id: string }>();
    await dispatchRunDirectly(env, bundle.run.id, dispatch!.id);
    await instance.waitForStatus("complete");
    const detail = await readSuccess<RunDetail>(await call(a, "/api/runs/" + bundle.run.id));
    expect(detail.status).toBe("SUCCEEDED");
    expect(detail.output).toEqual(["accepted"]);
    expect(detail.steps.find((s) => s.key === "no")!.status).toBe("SKIPPED");
    expect(detail.steps.find((s) => s.key === "yes")!.attempts[0]!.output).toBe("accepted");
    const trace = await readSuccess<{ items: { name: string; parent_span_id: string | null }[] }>(
      await call(a, `/api/projects/${a.projectId}/traces/execution:${bundle.run.id}`),
    );
    expect(trace.items.some((s) => s.name === "Attempt 1" && s.parent_span_id)).toBe(true);
  });
  it("rejects an approval and records its failure at the waiting step", async () => {
    const a = await account(),
      workflow = await createGraph(a),
      bundle = await launch(a, workflow, { payload: "review" });
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, bundle.run.id);
    const dispatch = await env.DB.prepare("SELECT id FROM execution_dispatches WHERE run_id=?")
      .bind(bundle.run.id)
      .first<{ id: string }>();
    await dispatchRunDirectly(env, bundle.run.id, dispatch!.id);
    const id = (await instance.waitForStepResult({ name: "review-approval-create" })) as string;
    await call(a, `/api/projects/${a.projectId}/approvals/${id}/decision`, "POST", {
      decision: "REJECTED",
    });
    await instance.waitForStatus("complete");
    const r = await readSuccess<RunDetail>(await call(a, "/api/runs/" + bundle.run.id));
    expect(r.status).toBe("FAILED");
    expect(r.steps.find((s) => s.key === "review")!.status).toBe("FAILED");
  });
  it("cancels an execution while it is waiting for approval", async () => {
    const a = await account(),
      workflow = await createGraph(a),
      bundle = await launch(a, workflow, {});
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, bundle.run.id);
    const dispatch = await env.DB.prepare("SELECT id FROM execution_dispatches WHERE run_id=?")
      .bind(bundle.run.id)
      .first<{ id: string }>();
    await dispatchRunDirectly(env, bundle.run.id, dispatch!.id);
    const id = (await instance.waitForStepResult({ name: "review-approval-create" })) as string;
    expect((await call(a, "/api/runs/" + bundle.run.id + "/cancel", "POST")).status).toBe(200);
    await instance.waitForStatus("complete");
    expect((await readSuccess<RunDetail>(await call(a, "/api/runs/" + bundle.run.id))).status).toBe(
      "CANCELLED",
    );
    expect(
      (await env.DB.prepare("SELECT status FROM approval_tasks WHERE id=?")
        .bind(id)
        .first<{ status: string }>())!.status,
    ).toBe("CANCELLED");
    const cancelled = await readSuccess<RunDetail>(await call(a, "/api/runs/" + bundle.run.id));
    expect(cancelled.steps.find((step) => step.key === "review")!.status).toBe("CANCELLED");
  });
  it("imports actual Studio JSON and rejects missing execution input", async () => {
    const a = await account(),
      base = `/api/projects/${a.projectId}/studio/import`;
    expect(
      (await call(a, base, "POST", { schemaVersion: 2, name: "Bad", graph: INITIAL_GRAPH })).status,
    ).toBe(400);
    const imported = await readSuccess<{ id: string }>(
      await call(a, base, "POST", {
        schemaVersion: 1,
        name: "Imported",
        description: "Portable graph",
        graph: INITIAL_GRAPH,
      }),
    );
    const detail = await readSuccess<{ graph: unknown }>(
      await call(a, `/api/projects/${a.projectId}/studio/${imported.id}`),
    );
    expect(detail.graph).toEqual(INITIAL_GRAPH);
    expect(
      (
        await call(a, "/api/runs", "POST", {
          workflowId: imported.id,
          version: 1,
          projectId: a.projectId,
          scenario: "success",
        })
      ).status,
    ).toBe(400);
  });
  it("expires overdue approvals and refuses a late decision", async () => {
    const a = await account(),
      workflow = await createGraph(a),
      bundle = await launch(a, workflow, {});
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, bundle.run.id);
    const dispatch = await env.DB.prepare("SELECT id FROM execution_dispatches WHERE run_id=?")
      .bind(bundle.run.id)
      .first<{ id: string }>();
    await dispatchRunDirectly(env, bundle.run.id, dispatch!.id);
    const id = (await instance.waitForStepResult({ name: "review-approval-create" })) as string;
    await env.DB.prepare("UPDATE approval_tasks SET expires_at=? WHERE id=?")
      .bind(isoFromNow(-1000), id)
      .run();
    await call(a, `/api/projects/${a.projectId}/approvals`);
    expect(
      (
        await call(a, `/api/projects/${a.projectId}/approvals/${id}/decision`, "POST", {
          decision: "APPROVED",
        })
      ).status,
    ).toBe(409);
    const actual = await env.RUN_WORKFLOW.get(bundle.run.id);
    await actual.sendEvent({ type: "approval:" + id, payload: { check: true } });
    await instance.waitForStatus("complete");
    expect((await readSuccess<RunDetail>(await call(a, "/api/runs/" + bundle.run.id))).status).toBe(
      "FAILED",
    );
    expect(
      (await env.DB.prepare("SELECT status FROM approval_tasks WHERE id=?")
        .bind(id)
        .first<{ status: string }>())!.status,
    ).toBe("EXPIRED");
  });
  it("pins model routes across configuration edits, idempotent replay and failed-run retry", async () => {
    const a = await account(),
      base = `/api/projects/${a.projectId}`,
      config = {
        name: "Pinned route",
        models: [{ provider: "groq", model: "original-model" }],
        timeoutMs: 1000,
        maxTokens: 30,
      },
      route = await readSuccess<{ id: string }>(
        await call(a, base + "/gateway/routes", "POST", config),
      ),
      w = await readSuccess<{ id: string }>(
        await call(a, base + "/studio", "POST", { name: "Model workflow" }),
      );
    const graph = {
      nodes: [
        INITIAL_GRAPH.nodes[0],
        {
          id: "model",
          name: "Model",
          type: "model",
          config: { routeId: route.id, prompt: "Summarize" },
          x: 300,
          y: 120,
        },
        INITIAL_GRAPH.nodes[1],
      ],
      edges: [
        ["input", "model"],
        ["model", "output"],
      ],
    };
    await call(a, base + "/studio/" + w.id, "PUT", {
      name: "Model workflow",
      description: "",
      revision: 1,
      graph,
    });
    await call(a, base + "/studio/" + w.id + "/publish", "POST", { revision: 2 });
    const bundle = await launch(a, w.id, {});
    await call(a, base + "/gateway/routes/" + route.id, "PUT", {
      revision: 1,
      config: { ...config, models: [{ provider: "groq", model: "new-model" }] },
    });
    await env.DB.prepare("UPDATE runs SET status='FAILED',completed_at=? WHERE id=?")
      .bind(nowIso(), bundle.run.id)
      .run();
    const retried = await readSuccess<{ run: { id: string } }>(
      await call(a, "/api/runs/" + bundle.run.id + "/retry", "POST"),
    );
    const rows = await env.DB.prepare(
      "SELECT route_json FROM run_model_routes WHERE run_id IN (?,?)",
    )
      .bind(bundle.run.id, retried.run.id)
      .all<{ route_json: string }>();
    expect(rows.results).toHaveLength(2);
    expect(
      rows.results.every((r) => JSON.parse(r.route_json).models[0].model === "original-model"),
    ).toBe(true);
    await call(a, base + "/gateway/routes/" + route.id, "DELETE");
    const replay = await call(a, "/api/runs", "POST", {
      workflowId: w.id,
      projectId: a.projectId,
      version: 1,
      input: {},
      scenario: "success",
    });
    expect(replay.status).toBe(200);
    expect((await readSuccess<LaunchRunResult>(replay)).run.id).toBe(bundle.run.id);
  });
  it("uses the Workers AI adapter and leaves absent usage/cost unavailable", async () => {
    const a = await account(),
      base = `/api/projects/${a.projectId}/gateway`;
    await call(a, base + "/credentials/workers", "PUT", {
      apiKey: "test-workers-token",
      accountId: "a".repeat(32),
    });
    const route = await readSuccess<{ id: string }>(
      await call(a, base + "/routes", "POST", {
        name: "Workers route",
        models: [{ provider: "workers", model: "@cf/meta/test-model" }],
      }),
    );
    const result = await callModel(env, a.projectId, route.id, "Test", {}, async (url, init) => {
      expect(String(url)).toBe(
        "https://api.cloudflare.com/client/v4/accounts/" +
          "a".repeat(32) +
          "/ai/run/%40cf/meta/test-model",
      );
      expect(JSON.parse(String(init?.body)).messages[0].content).toBe("Test");
      return Response.json({ success: true, result: { response: "Provider output" } });
    });
    expect(result.text).toBe("Provider output");
    expect(result.inputTokens).toBeNull();
    expect(result.estimatedCostUsd).toBeNull();
  });
});
