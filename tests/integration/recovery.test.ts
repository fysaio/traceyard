import { env, type WorkflowStep } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, apiFetchWithGitHub, readSuccess, ORIGIN } from "./helpers";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import { getRunRow } from "../../worker/persistence/runs";
import { executeGraph } from "../../worker/execution/graph";
import { dispatchRunDirectly } from "../../worker/queue/consumer";
import { INITIAL_GRAPH, type WorkflowGraph } from "../../shared/workflow/graph";
import type { LaunchRunResult, RunDetail, RetryRunResult } from "../../shared/contracts/api";

async function account(id = 1) {
  const user = await getOrCreateGitHubIdentity(env.DB, {
    id,
    login: "recovery-" + id,
    name: null,
    avatarUrl: null,
  });
  const auth = await createUserSession(env.DB, user.id, new Request(ORIGIN));
  return {
    cookie: (await createSession()).cookie + "; ty_auth_session=" + auth.token,
    projectId: (await getDefaultProjectId(env.DB, user.id))!,
  };
}
function call(a: { cookie: string }, path: string, method = "GET", body?: unknown, token?: string) {
  return apiFetchWithGitHub(
    path,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: "Bearer " + token } : {}),
        "idempotency-key": crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    async () => {
      throw Error("No GitHub calls expected");
    },
    a.cookie,
  );
}
async function published(a: Awaited<ReturnType<typeof account>>, graph: WorkflowGraph) {
  const base = `/api/projects/${a.projectId}/studio`;
  const w = await readSuccess<{ id: string }>(
    await call(a, base, "POST", { name: "Recover delivery" }),
  );
  expect(
    (
      await call(a, base + "/" + w.id, "PUT", {
        name: "Recover delivery",
        description: "",
        revision: 1,
        graph,
      })
    ).status,
  ).toBe(200);
  expect((await call(a, base + "/" + w.id + "/publish", "POST", { revision: 2 })).status).toBe(201);
  return w.id;
}
async function launched(a: Awaited<ReturnType<typeof account>>, id: string) {
  const response = await call(a, "/api/runs", "POST", {
    projectId: a.projectId,
    workflowId: id,
    input: { order: "123" },
    scenario: "success",
  });
  expect(response.status).toBe(202);
  return (await readSuccess<LaunchRunResult>(response)).run;
}
// Runs the actual graph executor with D1 and controlled HTTP responses. Durable
// Workflows replay/dispatch is covered independently in the binding test below.
const immediateStep = {
  do: async (
    _name: string,
    configOrCallback: unknown,
    callback?: (ctx: { attempt: number }) => Promise<unknown>,
  ) => (callback ?? (configOrCallback as typeof callback))!({ attempt: 1 }),
} as unknown as WorkflowStep;
async function execute(id: string, graph: WorkflowGraph) {
  return executeGraph(
    env.DB,
    (await getRunRow(env.DB, id))!,
    JSON.stringify(graph),
    immediateStep,
    env,
  );
}
async function connection(a: Awaited<ReturnType<typeof account>>, name: string) {
  return readSuccess<{ id: string }>(
    await call(a, `/api/projects/${a.projectId}/http-connections`, "POST", {
      name,
      url: "https://hooks.example.test/" + name,
      method: "POST",
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("execution recovery", () => {
  it("resumes real graph execution without repeating completed HTTP effects and preserves uncertain-request identity", async () => {
    const a = await account(),
      first = await connection(a, "first"),
      second = await connection(a, "second");
    const graph: WorkflowGraph = {
      nodes: [
        INITIAL_GRAPH.nodes[0]!,
        {
          id: "first",
          name: "Create order",
          type: "http",
          config: { connectionId: first.id },
          x: 200,
          y: 120,
        },
        {
          id: "second",
          name: "Notify warehouse",
          type: "http",
          config: { connectionId: second.id },
          x: 400,
          y: 120,
        },
        INITIAL_GRAPH.nodes[1]!,
      ],
      edges: [
        ["input", "first"],
        ["first", "second"],
        ["second", "output"],
      ],
    };
    const id = await published(a, graph),
      original = await launched(a, id);
    const calls: { url: string; key: string | null }[] = [];
    let unavailable = true;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), key: new Headers(init.headers).get("idempotency-key") });
      return String(url).endsWith("second") && unavailable
        ? new Response("Unavailable", { status: 503 })
        : Response.json({ saved: true });
    });
    expect((await execute(original.id, graph)).status).toBe("FAILED");
    const failed = await readSuccess<RunDetail>(await call(a, "/api/runs/" + original.id));
    expect(failed.error).toMatchObject({
      stepKey: "second",
      code: "HTTP_503",
      class: "TRANSIENT_DEPENDENCY",
      retryable: true,
    });
    expect(failed.steps.find((s) => s.key === "first")?.attemptCount).toBe(1);

    const recoveryResponse = await call(a, "/api/runs/" + original.id + "/retry", "POST", {
      mode: "resume",
    });
    expect(recoveryResponse.status).toBe(202);
    const recovery = await readSuccess<RetryRunResult>(recoveryResponse);
    expect(recovery.run.recoveryMode).toBe("resume");
    expect(recovery.run.input).toEqual(original.input);
    expect(recovery.run.workflow.version).toBe(original.workflow.version);
    // Removing a completed connection proves the resumed graph never enters it.
    await call(a, `/api/projects/${a.projectId}/http-connections/${first.id}`, "DELETE");
    unavailable = false;
    expect((await execute(recovery.run.id, graph)).status).toBe("SUCCEEDED");
    const completed = await readSuccess<RunDetail>(await call(a, "/api/runs/" + recovery.run.id));
    expect(completed.steps.find((s) => s.key === "first")).toMatchObject({
      reusedFromRunId: original.id,
      attemptCount: 0,
      durationMs: null,
      attempts: [],
    });
    expect(calls.filter((c) => c.url.endsWith("first"))).toHaveLength(1);
    const uncertain = calls.filter((c) => c.url.endsWith("second"));
    expect(uncertain).toHaveLength(2);
    expect(uncertain[0]!.key).toBe(original.id + ":second");
    expect(uncertain[1]!.key).toBe(uncertain[0]!.key);
    const events = await readSuccess<{ items: { type: string; stepKey: string }[] }>(
      await call(a, "/api/runs/" + recovery.run.id + "/events"),
    );
    expect(events.items).toContainEqual(
      expect.objectContaining({ type: "step.reused", stepKey: "first" }),
    );
    expect(
      events.items.filter((e) => e.type === "step.succeeded").map((e) => e.stepKey),
    ).not.toContain("first");
    expect((await readSuccess<RunDetail>(await call(a, "/api/runs/" + original.id))).status).toBe(
      "FAILED",
    );
  });

  it("executes recovered checkpoints through the durable Workflow binding and rebuilds branch selection", async () => {
    const a = await account();
    const graph: WorkflowGraph = {
      nodes: [
        INITIAL_GRAPH.nodes[0]!,
        {
          id: "condition",
          name: "Choose path",
          type: "condition",
          config: { path: "order", equals: "123", thenTarget: "yes", elseTarget: "no" },
          x: 200,
          y: 120,
        },
        {
          id: "yes",
          name: "Selected value",
          type: "literal",
          config: { value: "accepted" },
          x: 400,
          y: 50,
        },
        {
          id: "no",
          name: "Inactive value",
          type: "literal",
          config: { value: "rejected" },
          x: 400,
          y: 250,
        },
        { id: "merge", name: "Join", type: "merge", config: {}, x: 600, y: 120 },
        INITIAL_GRAPH.nodes[1]!,
      ],
      edges: [
        ["input", "condition"],
        ["condition", "yes"],
        ["condition", "no"],
        ["yes", "merge"],
        ["no", "merge"],
        ["merge", "output"],
      ],
    };
    const id = await published(a, graph),
      original = await launched(a, id);
    // Induce an infrastructure stop after persisted checkpoints, not a fake
    // successful run. The resumed binding must evaluate the remaining graph.
    await env.DB.batch([
      env.DB.prepare("UPDATE runs SET status='FAILED' WHERE id=?").bind(original.id),
      env.DB.prepare(
        "UPDATE execution_steps SET status='SUCCEEDED',output_json=input_json WHERE run_id=? AND step_key='input'",
      ).bind(original.id),
      env.DB.prepare(
        "UPDATE execution_steps SET status='SUCCEEDED',output_json='true' WHERE run_id=? AND step_key='condition'",
      ).bind(original.id),
    ]);
    // Input has not executed in this induced-stop fixture; retain its captured value.
    await env.DB.prepare(
      "UPDATE execution_steps SET output_json=? WHERE run_id=? AND step_key='input'",
    )
      .bind(JSON.stringify(original.input), original.id)
      .run();
    const response = await call(a, "/api/runs/" + original.id + "/retry", "POST", {
      mode: "resume",
    });
    expect(response.status).toBe(202);
    const recovery = await readSuccess<RetryRunResult>(response);
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, recovery.run.id);
    const dispatch = await env.DB.prepare("SELECT id FROM execution_dispatches WHERE run_id=?")
      .bind(recovery.run.id)
      .first<{ id: string }>();
    await dispatchRunDirectly(env, recovery.run.id, dispatch!.id);
    await instance.waitForStatus("complete");
    const detail = await readSuccess<RunDetail>(await call(a, "/api/runs/" + recovery.run.id));
    expect(detail.status).toBe("SUCCEEDED");
    expect(detail.output).toEqual(["accepted"]);
    expect(detail.steps.find((s) => s.key === "no")?.status).toBe("SKIPPED");
    expect(detail.steps.find((s) => s.key === "condition")?.attempts).toEqual([]);
  });

  it("isolates recovery by owner and API-key project and rejects changed recovery options", async () => {
    const a = await account(),
      other = await account(2),
      id = await published(a, INITIAL_GRAPH),
      original = await launched(a, id);
    await env.DB.prepare("UPDATE runs SET status='FAILED' WHERE id=?").bind(original.id).run();
    expect(
      (await call(other, "/api/runs/" + original.id + "/retry", "POST", { mode: "resume" })).status,
    ).toBe(404);
    expect(
      (
        await call(a, "/api/runs/" + original.id + "/retry", "POST", {
          mode: "resume",
          input: "replace",
        })
      ).status,
    ).toBe(400);
    const key = await readSuccess<{ token: string }>(
      await call(a, `/api/projects/${a.projectId}/keys`, "POST", {
        name: "Recovery",
        scopes: ["runs:write"],
      }),
    );
    const otherKey = await readSuccess<{ token: string }>(
      await call(other, `/api/projects/${other.projectId}/keys`, "POST", {
        name: "Other",
        scopes: ["runs:write"],
      }),
    );
    expect(
      (
        await call(
          a,
          "/api/v1/runs/" + original.id + "/retry",
          "POST",
          { mode: "resume" },
          otherKey.token,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          a,
          "/api/v1/runs/" + original.id + "/retry",
          "POST",
          { mode: "resume" },
          key.token,
        )
      ).status,
    ).toBe(202);
    expect(
      (await call(a, "/api/runs/" + original.id + "/retry", "POST", { mode: "restart" })).status,
    ).toBe(409);
  });

  it("retries transient HTTP errors with separate attempts, but never retries permanent errors", async () => {
    const a = await account(),
      endpoint = await connection(a, "transient");
    const graph: WorkflowGraph = {
      nodes: [
        INITIAL_GRAPH.nodes[0]!,
        {
          id: "request",
          name: "Deliver",
          type: "http",
          config: {
            connectionId: endpoint.id,
            retry: { maxAttempts: 3, baseDelayMs: 100, backoff: "exponential" },
          },
          x: 200,
          y: 100,
        },
        INITIAL_GRAPH.nodes[1]!,
      ],
      edges: [
        ["input", "request"],
        ["request", "output"],
      ],
    };
    const workflow = await published(a, graph),
      run = await launched(a, workflow);
    const attempts: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      attempts.push(new Headers(init.headers).get("idempotency-key")!);
      return attempts.length < 2
        ? new Response("Busy", { status: 429 })
        : Response.json({ delivered: true });
    });
    // This adapter exercises the callback/retry contract without wall-clock
    // backoff. Cloudflare's actual scheduling is tested with the built-in
    // document workflow in execution.test.ts.
    const retryStep = {
      do: async (
        _name: string,
        configOrCallback: unknown,
        callback?: (ctx: { attempt: number }) => Promise<unknown>,
      ) => {
        const fn = (callback ?? configOrCallback) as (ctx: { attempt: number }) => Promise<unknown>;
        const limit = callback
          ? (configOrCallback as { retries: { limit: number } }).retries.limit
          : 0;
        for (let attempt = 1; ; attempt++) {
          try {
            return await fn({ attempt });
          } catch (error) {
            if (attempt > limit || (error instanceof Error && error.name === "NonRetryableError"))
              throw error;
          }
        }
      },
    } as unknown as WorkflowStep;
    expect(
      (
        await executeGraph(
          env.DB,
          (await getRunRow(env.DB, run.id))!,
          JSON.stringify(graph),
          retryStep,
          env,
        )
      ).status,
    ).toBe("SUCCEEDED");
    const detail = await readSuccess<RunDetail>(await call(a, "/api/runs/" + run.id));
    const request = detail.steps.find((s) => s.key === "request")!;
    expect(request.maxAttempts).toBe(3);
    expect(request.attempts.map((r) => r.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(attempts).toEqual([run.id + ":request", run.id + ":request"]);
    const permanent = await launched(a, workflow);
    let count = 0;
    vi.stubGlobal("fetch", async () => {
      count++;
      return new Response("Bad request", { status: 400 });
    });
    expect(
      (
        await executeGraph(
          env.DB,
          (await getRunRow(env.DB, permanent.id))!,
          JSON.stringify(graph),
          retryStep,
          env,
        )
      ).status,
    ).toBe("FAILED");
    expect(count).toBe(1);
    expect(
      (await readSuccess<RunDetail>(await call(a, "/api/runs/" + permanent.id))).error,
    ).toMatchObject({ code: "HTTP_400", retryable: false, stepKey: "request" });
  });

  it("does not ask for a completed approval again after a later HTTP failure", async () => {
    const a = await account();
    const endpoint = await connection(a, "after-review");
    const graph: WorkflowGraph = {
      nodes: [
        INITIAL_GRAPH.nodes[0]!,
        { id: "review", name: "Review", type: "approval", config: {}, x: 200, y: 100 },
        {
          id: "delivery",
          name: "Deliver",
          type: "http",
          config: { connectionId: endpoint.id },
          x: 400,
          y: 100,
        },
        INITIAL_GRAPH.nodes[1]!,
      ],
      edges: [
        ["input", "review"],
        ["review", "delivery"],
        ["delivery", "output"],
      ],
    };
    const workflow = await published(a, graph),
      original = await launched(a, workflow);
    const approvingStep = {
      ...immediateStep,
      waitForEvent: async () => {
        // The actual approval service creates and reads this task. The fixture
        // supplies the owner decision without a wall-clock event wait.
        await env.DB.prepare(
          "UPDATE approval_tasks SET status='APPROVED' WHERE run_id=? AND status='PENDING'",
        )
          .bind(original.id)
          .run();
        return { type: "approval", payload: {}, timestamp: new Date() };
      },
    } as unknown as WorkflowStep;
    vi.stubGlobal("fetch", async () => new Response("Busy", { status: 503 }));
    expect(
      (
        await executeGraph(
          env.DB,
          (await getRunRow(env.DB, original.id))!,
          JSON.stringify(graph),
          approvingStep,
          env,
        )
      ).status,
    ).toBe("FAILED");
    expect(
      (await readSuccess<RunDetail>(await call(a, "/api/runs/" + original.id))).steps.find(
        (s) => s.key === "review",
      )?.status,
    ).toBe("SUCCEEDED");
    const recovery = await readSuccess<RetryRunResult>(
      await call(a, "/api/runs/" + original.id + "/retry", "POST", { mode: "resume" }),
    );
    vi.stubGlobal("fetch", async () => Response.json({ delivered: true }));
    // immediateStep has no event-wait implementation: any repeated approval
    // would fail this recovered execution.
    expect((await execute(recovery.run.id, graph)).status).toBe("SUCCEEDED");
    const approvals = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM approval_tasks WHERE run_id=?",
    )
      .bind(recovery.run.id)
      .first<{ count: number }>();
    expect(approvals?.count).toBe(0);
    const stopped = await launched(a, workflow);
    await env.DB.prepare("UPDATE runs SET status='FAILED' WHERE id=?").bind(stopped.id).run();
    const restart = await readSuccess<RetryRunResult>(
      await call(a, "/api/runs/" + stopped.id + "/retry", "POST", { mode: "restart" }),
    );
    expect(restart.run.steps.every((s) => s.status === "PENDING" && !s.reusedFromRunId)).toBe(true);
    expect((await getRunRow(env.DB, restart.run.id))?.effect_scope_id).toBe(restart.run.id);
  });

  it("stops a missing model configuration instead of retrying or inventing an agent result", async () => {
    const a = await account();
    const route = await readSuccess<{ id: string }>(
      await call(a, `/api/projects/${a.projectId}/gateway/routes`, "POST", {
        name: "Unconfigured",
        models: [{ provider: "groq", model: "test-model" }],
        timeoutMs: 1000,
        maxTokens: 30,
      }),
    );
    const graph: WorkflowGraph = {
      nodes: [
        INITIAL_GRAPH.nodes[0]!,
        {
          id: "agent",
          name: "Agent response",
          type: "model",
          config: {
            routeId: route.id,
            retry: { maxAttempts: 3, baseDelayMs: 100, backoff: "fixed" },
          },
          x: 200,
          y: 100,
        },
        INITIAL_GRAPH.nodes[1]!,
      ],
      edges: [
        ["input", "agent"],
        ["agent", "output"],
      ],
    };
    const workflow = await published(a, graph),
      run = await launched(a, workflow);
    const network = vi.fn(async () => {
      throw Error("Must not call an unconfigured provider");
    });
    vi.stubGlobal("fetch", network);
    expect((await execute(run.id, graph)).status).toBe("FAILED");
    expect(network).not.toHaveBeenCalled();
    const detail = await readSuccess<RunDetail>(await call(a, "/api/runs/" + run.id));
    expect(detail.output).toBeNull();
    expect(detail.error).toMatchObject({
      code: "PROVIDER_UNCONFIGURED",
      retryable: false,
      stepKey: "agent",
    });
    expect(detail.steps.find((s) => s.key === "agent")?.attemptCount).toBe(1);
  });

  it("retains model evidence and recovers a failed agent tool delivery without another model request", async () => {
    const a = await account(),
      endpoint = await connection(a, "agent-tool");
    expect(
      (
        await call(a, `/api/projects/${a.projectId}/gateway/credentials/groq`, "PUT", {
          apiKey: "test-only-not-a-real-provider-key",
        })
      ).status,
    ).toBe(200);
    const route = await readSuccess<{ id: string }>(
      await call(a, `/api/projects/${a.projectId}/gateway/routes`, "POST", {
        name: "Agent",
        models: [{ provider: "groq", model: "test-model" }],
        timeoutMs: 1000,
        maxTokens: 30,
      }),
    );
    const graph: WorkflowGraph = {
      nodes: [
        INITIAL_GRAPH.nodes[0]!,
        {
          id: "agent",
          name: "Plan delivery",
          type: "model",
          config: { routeId: route.id, prompt: "Return the delivery record as JSON." },
          x: 200,
          y: 100,
        },
        {
          id: "text",
          name: "Response text",
          type: "pick",
          config: { path: "text" },
          x: 400,
          y: 100,
        },
        {
          id: "parse",
          name: "Validate tool input",
          type: "parse",
          config: { requiredFields: ["order"] },
          x: 600,
          y: 100,
        },
        {
          id: "tool",
          name: "Deliver order",
          type: "http",
          config: { connectionId: endpoint.id },
          x: 800,
          y: 100,
        },
        INITIAL_GRAPH.nodes[1]!,
      ],
      edges: [
        ["input", "agent"],
        ["agent", "text"],
        ["text", "parse"],
        ["parse", "tool"],
        ["tool", "output"],
      ],
    };
    const workflow = await published(a, graph),
      original = await launched(a, workflow);
    let modelRequests = 0,
      ready = false;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).includes("api.groq.com")) {
        modelRequests++;
        return Response.json({
          choices: [{ message: { content: '{"order":"123"}' } }],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        });
      }
      expect(JSON.parse(String(init.body))).toEqual({ order: "123" });
      return ready
        ? Response.json({ delivered: true })
        : new Response("Unavailable", { status: 503 });
    });
    expect((await execute(original.id, graph)).status).toBe("FAILED");
    const failed = await readSuccess<RunDetail>(await call(a, "/api/runs/" + original.id));
    expect(failed.steps.find((s) => s.key === "agent")?.output).toMatchObject({
      text: '{"order":"123"}',
      provider: "groq",
      usage: { inputTokens: 12, outputTokens: 8 },
    });
    expect(failed.error?.stepKey).toBe("tool");
    const recovery = await readSuccess<RetryRunResult>(
      await call(a, "/api/runs/" + original.id + "/retry", "POST", { mode: "resume" }),
    );
    ready = true;
    expect((await execute(recovery.run.id, graph)).status).toBe("SUCCEEDED");
    expect(modelRequests).toBe(1);
    const models = await env.DB.prepare(
      "SELECT run_id,status FROM model_requests WHERE project_id=?",
    )
      .bind(a.projectId)
      .all();
    expect(models.results).toEqual([{ run_id: original.id, status: "SUCCEEDED" }]);
    const result = await readSuccess<RunDetail>(await call(a, "/api/runs/" + recovery.run.id));
    expect(result.steps.find((s) => s.key === "agent")).toMatchObject({
      reusedFromRunId: original.id,
      attempts: [],
    });
    expect(result.output).toMatchObject({ data: { delivered: true } });
  });

  it("corrects invalid input in a linked execution without reusing stale checkpoints or changing the original", async () => {
    const a = await account(),
      stranger = await account(2);
    const graph: WorkflowGraph = {
      nodes: [
        INITIAL_GRAPH.nodes[0]!,
        {
          id: "parse",
          name: "Parse request",
          type: "parse",
          config: { requiredFields: ["order"] },
          x: 200,
          y: 100,
        },
        INITIAL_GRAPH.nodes[1]!,
      ],
      edges: [
        ["input", "parse"],
        ["parse", "output"],
      ],
    };
    const workflow = await published(a, graph),
      original = await launched(a, workflow);
    // The initial object is invalid for a JSON-text parsing node.
    expect((await execute(original.id, graph)).status).toBe("FAILED");
    const body = {
      projectId: a.projectId,
      workflowId: workflow,
      version: 1,
      parentRunId: original.id,
      input: '{"order":"corrected"}',
      scenario: "success",
    };
    expect(
      (await call(stranger, "/api/runs", "POST", { ...body, projectId: stranger.projectId }))
        .status,
    ).toBe(404);
    const response = await call(a, "/api/runs", "POST", body);
    expect(response.status).toBe(202);
    const fork = (await readSuccess<LaunchRunResult>(response)).run;
    expect(fork.parentRunId).toBe(original.id);
    expect(fork.retryOfRunId).toBeNull();
    expect(fork.steps.every((s) => !s.reusedFromRunId)).toBe(true);
    expect((await execute(fork.id, graph)).status).toBe("SUCCEEDED");
    const result = await readSuccess<RunDetail>(await call(a, "/api/runs/" + fork.id));
    expect(result.output).toEqual({ order: "corrected" });
    const source = await readSuccess<RunDetail>(await call(a, "/api/runs/" + original.id));
    expect(source.status).toBe("FAILED");
    expect(source.input).toEqual({ order: "123" });
    expect(source.retryRunId).toBeNull();
  });
});
