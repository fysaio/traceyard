import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type {
  AnalyticsPayload,
  EventListPage,
  OverviewPayload,
  RunDetail,
  RunListPage,
  SandboxStatus,
  WorkflowSummary,
} from "../../shared/contracts/api";
import {
  apiFetch,
  createSession,
  getRunDetail,
  launchBody,
  launchRun,
  postJson,
  readFailure,
  readSuccess,
  seedRun,
  VALID_INPUT,
} from "./helpers";

describe("health and catalog", () => {
  it("reports a healthy database and issues a session cookie", async () => {
    const response = await apiFetch("/api/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/u);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toContain("ty_session=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");

    const body = await readSuccess<{
      status: string;
      checks: { database: { status: string } };
    }>(response);
    expect(body.status).toBe("ok");
    expect(body.checks.database.status).toBe("ok");
  });

  it("returns the executable workflow catalog", async () => {
    const session = await createSession();
    const response = await apiFetch("/api/workflows", {}, session);
    const body = await readSuccess<{ items: WorkflowSummary[] }>(response);
    expect(body.items).toHaveLength(1);

    const workflow = body.items[0];
    expect(workflow?.slug).toBe("document-intelligence");
    expect(workflow?.version).toBe(1);
    expect(workflow?.steps.map((step) => step.key)).toEqual([
      "validate-input",
      "normalize-content",
      "extract-insights",
      "validate-output",
      "persist-result",
    ]);

    const detail = await apiFetch("/api/workflows/document-intelligence", {}, session);
    expect((await readSuccess<WorkflowSummary>(detail)).id).toBe("wf_document_intelligence");
  });

  it("returns 404 for an unknown workflow", async () => {
    const session = await createSession();
    const response = await apiFetch("/api/workflows/nope", {}, session);
    expect(response.status).toBe(404);
    expect((await readFailure(response)).code).toBe("NOT_FOUND");
  });
});

describe("launch request validation", () => {
  it("rejects an invalid document without persisting a run", async () => {
    const session = await createSession();
    const response = await postJson(
      "/api/runs",
      launchBody({ input: { title: "ab", document: "short" } }),
      session,
    );
    expect(response.status).toBe(400);
    expect((await readFailure(response)).code).toBe("INVALID_DOCUMENT_INPUT");

    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM runs").first<{
      count: number;
    }>();
    expect(Number(count?.count)).toBe(0);
  });

  it("rejects an unknown workflow", async () => {
    const session = await createSession();
    const response = await postJson("/api/runs", launchBody({ workflowId: "nope" }), session);
    expect(response.status).toBe(404);
  });

  it("requires a JSON content type", async () => {
    const session = await createSession();
    const response = await apiFetch("/api/runs", { method: "POST", body: "{}" }, session);
    expect(response.status).toBe(400);
    expect((await readFailure(response)).code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects malformed JSON", async () => {
    const session = await createSession();
    const response = await apiFetch(
      "/api/runs",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{" },
      session,
    );
    expect(response.status).toBe(400);
    expect((await readFailure(response)).code).toBe("INVALID_JSON");
  });

  it("rejects a body over the 32 KB limit", async () => {
    const session = await createSession();
    const response = await postJson(
      "/api/runs",
      launchBody({ input: { title: "Large", document: "x".repeat(40_000) } }),
      session,
    );
    expect(response.status).toBe(400);
    expect((await readFailure(response)).code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects unknown request properties", async () => {
    const session = await createSession();
    const response = await postJson("/api/runs", { ...launchBody(), unexpected: true }, session);
    expect(response.status).toBe(400);
    expect((await readFailure(response)).code).toBe("VALIDATION_ERROR");
  });

  it("rejects cross-origin writes", async () => {
    const session = await createSession();
    const response = await apiFetch(
      "/api/runs",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify(launchBody()),
      },
      session,
    );
    expect(response.status).toBe(403);
    expect((await readFailure(response)).code).toBe("CROSS_ORIGIN_REJECTED");
  });
});

describe("launching a run", () => {
  it("persists a run, its step plan, dispatch outbox and initial events", async () => {
    const session = await createSession();
    const { response, result } = await launchRun(session);
    expect(response.status).toBe(202);
    expect(result).not.toBeNull();

    const detail = result!.run;
    expect(detail.id).toMatch(/^run_[a-f0-9]{32}$/u);
    expect(detail.status).toBe("QUEUED");
    expect(detail.workflow.slug).toBe("document-intelligence");
    expect(detail.correlationId).toMatch(/^cor_[a-f0-9]{32}$/u);
    expect(detail.steps).toHaveLength(5);
    expect(detail.steps.every((step) => step.status === "PENDING")).toBe(true);
    expect(detail.stepCounts.pending).toBe(5);
    expect(detail.dispatch.status).not.toBe("PENDING");
    expect(result!.replayed).toBe(false);

    const events = await env.DB.prepare(
      `SELECT type FROM execution_events WHERE run_id = ? ORDER BY seq ASC`,
    )
      .bind(detail.id)
      .all<{ type: string }>();
    expect(events.results.map((event) => event.type)).toEqual(["run.created", "dispatch.pending"]);
  });

  it("scopes a run to its anonymous session", async () => {
    const owner = await createSession();
    const stranger = await createSession();
    const { result } = await launchRun(owner);
    const runId = result!.run.id;

    expect((await apiFetch(`/api/runs/${runId}`, {}, stranger)).status).toBe(404);
    expect((await apiFetch(`/api/runs/${runId}/events`, {}, stranger)).status).toBe(404);
    expect((await postJson(`/api/runs/${runId}/cancel`, {}, stranger)).status).toBe(404);

    const strangerList = await readSuccess<RunListPage>(await apiFetch("/api/runs", {}, stranger));
    expect(strangerList.items).toHaveLength(0);
  });

  it("returns the run detail with steps, attempts and dispatch metadata", async () => {
    const session = await createSession();
    const { result } = await launchRun(session);
    const detail = await getRunDetail(session, result!.run.id);
    expect(detail.id).toBe(result!.run.id);
    expect(detail.scenario).toBe("success");
    expect(detail.input).toEqual(VALID_INPUT);
    expect(detail.dispatch.attempts).toBeGreaterThanOrEqual(1);
    expect(detail.steps.map((step) => step.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(detail.steps[0]?.maxAttempts).toBe(1);
    expect(detail.steps[1]?.maxAttempts).toBe(3);
  });
});

describe("idempotency and de-duplication", () => {
  it("replays the original run for the same key and body", async () => {
    const session = await createSession();
    const first = await launchRun(session, {}, "client-key-0001");
    const second = await launchRun(session, {}, "client-key-0001");

    expect(first.response.status).toBe(202);
    expect(second.response.status).toBe(200);
    expect(second.result?.replayed).toBe(true);
    expect(second.result?.run.id).toBe(first.result?.run.id);

    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM runs").first<{
      count: number;
    }>();
    expect(Number(count?.count)).toBe(1);
  });

  it("rejects a reused key with a different body", async () => {
    const session = await createSession();
    await launchRun(session, {}, "client-key-0002");
    const second = await launchRun(
      session,
      { input: { ...VALID_INPUT, title: "A different title" } },
      "client-key-0002",
    );
    expect(second.response.status).toBe(422);
    expect((await readFailure(second.response)).code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects a malformed idempotency key", async () => {
    const session = await createSession();
    const response = await postJson("/api/runs", launchBody(), session, {
      "idempotency-key": "short",
    });
    expect(response.status).toBe(400);
    expect((await readFailure(response)).code).toBe("INVALID_IDEMPOTENCY_KEY");
  });

  it("de-duplicates an accidental double submission without a key", async () => {
    const session = await createSession();
    const first = await launchRun(session);
    const second = await launchRun(session);
    expect(second.response.status).toBe(200);
    expect(second.result?.replayed).toBe(true);
    expect(second.result?.run.id).toBe(first.result?.run.id);
  });

  it("does not de-duplicate a request that changes the scenario", async () => {
    const session = await createSession();
    const first = await launchRun(session, { scenario: "success" });
    const second = await launchRun(session, { scenario: "terminal_failure" });
    expect(second.response.status).toBe(202);
    expect(second.result?.run.id).not.toBe(first.result?.run.id);
    expect(second.result?.run.scenario).toBe("terminal_failure");
  });
});

describe("run listing and event pagination", () => {
  it("paginates with an opaque cursor", async () => {
    const session = await createSession();
    const first = await launchRun(session, {
      input: { ...VALID_INPUT, title: "First document" },
    });
    const second = await launchRun(session, {
      input: { ...VALID_INPUT, title: "Second document" },
    });

    const pageOne = await readSuccess<RunListPage>(
      await apiFetch("/api/runs?limit=1", {}, session),
    );
    expect(pageOne.items).toHaveLength(1);
    expect(pageOne.nextCursor).not.toBeNull();

    const pageTwo = await readSuccess<RunListPage>(
      await apiFetch(`/api/runs?limit=1&cursor=${pageOne.nextCursor}`, {}, session),
    );
    expect(pageTwo.items).toHaveLength(1);
    expect(pageTwo.items[0]?.id).not.toBe(pageOne.items[0]?.id);

    const ids = [first.result?.run.id, second.result?.run.id];
    expect(ids).toContain(pageOne.items[0]?.id);
    expect(ids).toContain(pageTwo.items[0]?.id);
  });

  it("rejects an invalid cursor and an invalid status filter", async () => {
    const session = await createSession();
    const badCursor = await apiFetch("/api/runs?cursor=not-a-cursor", {}, session);
    expect(badCursor.status).toBe(400);
    expect((await readFailure(badCursor)).code).toBe("INVALID_CURSOR");

    const badStatus = await apiFetch("/api/runs?status=NOPE", {}, session);
    expect(badStatus.status).toBe(400);
  });

  it("paginates events after a sequence number", async () => {
    const session = await createSession();
    const { result } = await launchRun(session);
    const runId = result!.run.id;

    const firstPage = await readSuccess<EventListPage>(
      await apiFetch(`/api/runs/${runId}/events?limit=1`, {}, session),
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await readSuccess<EventListPage>(
      await apiFetch(
        `/api/runs/${runId}/events?limit=10&after=${firstPage.nextCursor}`,
        {},
        session,
      ),
    );
    expect(secondPage.items.length).toBeGreaterThanOrEqual(1);
    expect(secondPage.items[0]?.seq).toBeGreaterThan(firstPage.items[0]!.seq);
  });
});

describe("cancellation", () => {
  it("cancels a queued run, skips its steps and closes the dispatch", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });

    const response = await postJson(`/api/runs/${runId}/cancel`, {}, session);
    expect(response.status).toBe(200);
    const body = await readSuccess<{ status: string; accepted: boolean }>(response);
    expect(body.status).toBe("CANCELLED");
    expect(body.accepted).toBe(true);

    const detail = await getRunDetail(session, runId);
    expect(detail.status).toBe("CANCELLED");
    expect(detail.cancelRequestedAt).not.toBeNull();
    expect(detail.steps.every((step) => step.status === "SKIPPED")).toBe(true);
    expect(detail.dispatch.status).toBe("CANCELLED");
    expect(detail.stepCounts.skipped).toBe(5);
  });

  it("is idempotent for an already-cancelled run", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    await postJson(`/api/runs/${runId}/cancel`, {}, session);
    const second = await postJson(`/api/runs/${runId}/cancel`, {}, session);
    expect(second.status).toBe(200);
    expect((await readSuccess<{ status: string }>(second)).status).toBe("CANCELLED");
  });

  it("refuses to cancel a failed run", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session, status: "FAILED" });
    const response = await postJson(`/api/runs/${runId}/cancel`, {}, session);
    expect(response.status).toBe(409);
    expect((await readFailure(response)).code).toBe("RUN_ALREADY_TERMINAL");
  });
});

describe("retry", () => {
  it("creates exactly one new run linked to the failed original", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session, status: "FAILED" });

    const response = await postJson(`/api/runs/${runId}/retry`, {}, session);
    expect(response.status).toBe(202);
    const result = await readSuccess<{ run: RunDetail; originalRunId: string }>(response);
    expect(result.originalRunId).toBe(runId);
    expect(result.run.retryOfRunId).toBe(runId);
    expect(result.run.triggerSource).toBe("retry");
    expect(result.run.status).toBe("QUEUED");
    expect(result.run.steps).toHaveLength(5);

    const original = await getRunDetail(session, runId);
    expect(original.retryRunId).toBe(result.run.id);

    const again = await postJson(`/api/runs/${runId}/retry`, {}, session);
    expect(again.status).toBe(409);
    expect((await readFailure(again)).code).toBe("RETRY_ALREADY_EXISTS");
  });

  it("refuses to retry a run that did not fail", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    const response = await postJson(`/api/runs/${runId}/retry`, {}, session);
    expect(response.status).toBe(409);
    expect((await readFailure(response)).code).toBe("RUN_NOT_RETRYABLE");
  });
});

describe("operational endpoints", () => {
  it("reports overview figures from persisted runs only", async () => {
    const session = await createSession();
    await launchRun(session);

    const overview = await readSuccess<OverviewPayload>(
      await apiFetch("/api/overview?days=14", {}, session),
    );
    expect(overview.totals.runs).toBe(1);
    expect(overview.window.runs).toBe(1);
    expect(overview.trend).toHaveLength(14);
    expect(overview.recentRuns).toHaveLength(1);
    expect(overview.sandbox.globalRunsToday).toBe(1);
    expect(overview.executionDuration.sampleSize).toBe(0);
  });

  it("reports analytics without fabricated samples", async () => {
    const session = await createSession();
    await launchRun(session);

    const analytics = await readSuccess<AnalyticsPayload>(
      await apiFetch("/api/analytics?days=7", {}, session),
    );
    expect(analytics.windowDays).toBe(7);
    expect(analytics.trend).toHaveLength(7);
    expect(analytics.executionDuration.sampleSize).toBe(0);
    expect(analytics.stepDurations).toHaveLength(0);
  });

  it("exposes the caller's quota usage", async () => {
    const session = await createSession();
    await launchRun(session);

    const status = await readSuccess<SandboxStatus>(await apiFetch("/api/sandbox", {}, session));
    expect(status.enabled).toBe(true);
    expect(status.sessionRunsToday).toBe(1);
    expect(status.sessionRunsThisHour).toBe(1);
    expect(status.sessionDailyLimit).toBe(20);
    expect(status.sessionHourlyLimit).toBe(6);
    expect(status.globalDailyLimit).toBe(100);
  });

  it("returns a safe 404 for an unknown API route", async () => {
    const response = await apiFetch("/api/does-not-exist");
    expect(response.status).toBe(404);
    expect((await readFailure(response)).code).toBe("NOT_FOUND");
  });

  it("enforces the session hourly quota without leaking internals", async () => {
    const session = await createSession();
    for (let index = 0; index < 6; index += 1) {
      const { response } = await launchRun(session, {
        input: { ...VALID_INPUT, title: `Document number ${index}` },
      });
      expect(response.status).toBe(202);
    }
    const seventh = await launchRun(session, {
      input: { ...VALID_INPUT, title: "Document number seven" },
    });
    expect(seventh.response.status).toBe(429);
    const failure = await readFailure(seventh.response);
    expect(failure.code).toBe("SESSION_HOURLY_QUOTA");
    expect(failure.message).toContain("hourly execution allowance");
    expect(seventh.response.headers.get("retry-after")).not.toBeNull();
  });
});
