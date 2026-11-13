import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { normalizeContent } from "../../shared/workflow/document";
import { getSteps } from "../../worker/persistence/runs";
import {
  apiFetch,
  createSession,
  deliverDispatch,
  getRunDetail,
  readSuccess,
  seedRun,
  VALID_INPUT,
} from "./helpers";

describe("workflow execution", () => {
  it("executes every step and commits the verified output", async () => {
    const session = await createSession();
    const { runId, dispatchId } = await seedRun({ session });

    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, runId);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });

    const queueResult = await deliverDispatch(runId, dispatchId);
    expect(queueResult.explicitAcks).toHaveLength(1);

    await instance.waitForStatus("complete");

    const detail = await getRunDetail(session, runId);
    expect(detail.status).toBe("SUCCEEDED");
    expect(detail.startedAt).not.toBeNull();
    expect(detail.completedAt).not.toBeNull();
    expect(detail.durationMs).not.toBeNull();
    expect(detail.error).toBeNull();
    expect(detail.stepCounts.succeeded).toBe(5);
    expect(detail.stepCounts.pending).toBe(0);
    expect(detail.dispatch.status).toBe("CLAIMED");

    for (const step of detail.steps) {
      expect(step.status).toBe("SUCCEEDED");
      expect(step.attemptCount).toBe(1);
      expect(step.attempts).toHaveLength(1);
      expect(step.attempts[0]?.status).toBe("SUCCEEDED");
    }

    const output = detail.output as {
      title: string;
      digest: string;
      keywords: unknown[];
      summary: string;
    };
    expect(output.title).toBe(VALID_INPUT.title);
    expect(output.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(output.keywords.length).toBeGreaterThan(0);
    expect(output.summary.length).toBeGreaterThan(0);

    const committed = await env.DB.prepare(
      `SELECT digest, output_json FROM workflow_outputs WHERE run_id = ?`,
    )
      .bind(runId)
      .first<{ digest: string; output_json: string }>();
    expect(committed?.digest).toBe(output.digest);
    expect(JSON.parse(committed!.output_json)).toEqual(output);

    const events = await env.DB.prepare(
      `SELECT type FROM execution_events WHERE run_id = ? ORDER BY seq ASC`,
    )
      .bind(runId)
      .all<{ type: string }>();
    const types = events.results.map((event) => event.type);
    expect(types).toContain("run.started");
    expect(types.filter((type) => type === "step.succeeded")).toHaveLength(5);
    expect(types).toContain("run.succeeded");
    expect(types).not.toContain("run.failed");
  });

  it("retries a transient dependency failure and then succeeds", async () => {
    const session = await createSession();
    const { runId, dispatchId } = await seedRun({
      session,
      scenario: "retryable_failure",
    });

    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, runId);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });

    await deliverDispatch(runId, dispatchId);
    await instance.waitForStatus("complete");

    const detail = await getRunDetail(session, runId);
    expect(detail.status).toBe("SUCCEEDED");

    const extract = detail.steps.find((step) => step.key === "extract-insights");
    expect(extract?.status).toBe("SUCCEEDED");
    expect(extract?.attemptCount).toBe(2);
    expect(extract?.attempts).toHaveLength(2);
    expect(extract?.attempts[0]?.status).toBe("FAILED");
    expect(extract?.attempts[0]?.error?.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(extract?.attempts[0]?.error?.retryable).toBe(true);
    expect(extract?.attempts[1]?.status).toBe("SUCCEEDED");

    const failedAttemptEvent = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM execution_events
        WHERE run_id = ? AND type = 'step.attempt.failed' AND step_key = 'extract-insights'`,
    )
      .bind(runId)
      .first<{ count: number }>();
    expect(Number(failedAttemptEvent?.count)).toBe(1);
  });

  it("fails permanently without retrying a terminal application error", async () => {
    const session = await createSession();
    const { runId, dispatchId } = await seedRun({
      session,
      scenario: "terminal_failure",
    });

    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, runId);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });

    await deliverDispatch(runId, dispatchId);
    await instance.waitForStatus("complete");

    const detail = await getRunDetail(session, runId);
    expect(detail.status).toBe("FAILED");
    expect(detail.error).toMatchObject({
      class: "PERMANENT_APPLICATION",
      code: "DOCUMENT_UNPROCESSABLE",
      retryable: false,
      stepKey: "extract-insights",
      attempt: 1,
    });
    expect(detail.output).toBeNull();

    const extract = detail.steps.find((step) => step.key === "extract-insights");
    expect(extract?.status).toBe("FAILED");
    expect(extract?.attemptCount).toBe(1);
    expect(extract?.attempts).toHaveLength(1);
    expect(extract?.attempts[0]?.status).toBe("FAILED");

    const pending = detail.steps.filter((step) => step.status === "PENDING");
    expect(pending.map((step) => step.key)).toEqual(["validate-output", "persist-result"]);

    const output = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM workflow_outputs WHERE run_id = ?`,
    )
      .bind(runId)
      .first<{ count: number }>();
    expect(Number(output?.count)).toBe(0);

    // A failed run is retryable, and the retry reuses the stored input.
    const retry = await fetchRetry(detail.id, session);
    expect(retry.status).toBe("QUEUED");
    expect(retry.retryOfRunId).toBe(runId);
    expect(retry.input).toEqual(VALID_INPUT);
  });

  it("requests cancellation on a running execution and finalizes at a checkpoint", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    const now = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE runs SET status = 'RUNNING', started_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(now, now, runId),
      env.DB.prepare(
        `UPDATE execution_dispatches SET status = 'CLAIMED', claimed_at = ?, updated_at = ?
          WHERE run_id = ?`,
      ).bind(now, now, runId),
    ]);

    const response = await apiFetch(`/api/runs/${runId}/cancel`, { method: "POST" }, session);
    expect(response.status).toBe(200);
    const body = await readSuccess<{ status: string; accepted: boolean }>(response);
    expect(body.status).toBe("CANCELLING");
    expect(body.accepted).toBe(true);

    // Model the engine starting after the cancellation request was committed.
    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, runId);
    await env.RUN_WORKFLOW.create({
      id: runId,
      params: { runId, correlationId: "cor_cancel" },
    });
    await instance.waitForStatus("complete");

    const detail = await getRunDetail(session, runId);
    expect(detail.status).toBe("CANCELLED");
    expect(detail.cancelRequestedAt).not.toBeNull();
    expect(detail.completedAt).not.toBeNull();
    expect(detail.steps.every((step) => step.status === "SKIPPED")).toBe(true);
    expect(detail.stepCounts.skipped).toBe(5);

    const second = await apiFetch(`/api/runs/${runId}/cancel`, { method: "POST" }, session);
    expect(second.status).toBe(200);
    expect((await readSuccess<{ status: string }>(second)).status).toBe("CANCELLED");
  });

  it("acknowledges a duplicate queue delivery without executing twice", async () => {
    const session = await createSession();
    const { runId, dispatchId } = await seedRun({ session });

    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, runId);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });

    const first = await deliverDispatch(runId, dispatchId);
    expect(first.explicitAcks).toHaveLength(1);

    const duplicate = await deliverDispatch(runId, dispatchId);
    expect(duplicate.explicitAcks).toHaveLength(1);
    expect(duplicate.retryMessages).toHaveLength(0);

    await instance.waitForStatus("complete");

    const detail = await getRunDetail(session, runId);
    expect(detail.status).toBe("SUCCEEDED");
    for (const step of detail.steps) {
      expect(step.attemptCount).toBe(1);
    }

    const duplicates = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM execution_events
        WHERE run_id = ? AND type = 'step.succeeded'`,
    )
      .bind(runId)
      .first<{ count: number }>();
    expect(Number(duplicates?.count)).toBe(5);
  });

  it("resumes an interrupted run from its durable step checkpoints", async () => {
    const session = await createSession();
    const { runId, dispatchId } = await seedRun({ session });

    const normalized = normalizeContent(VALID_INPUT);
    const inputJson = JSON.stringify(VALID_INPUT);
    const now = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE runs SET status = 'RUNNING', started_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(now, now, runId),
      env.DB.prepare(
        `UPDATE execution_steps
            SET status = 'SUCCEEDED', attempt_count = 1, input_json = ?,
                output_json = ?, started_at = ?, completed_at = ?, updated_at = ?
          WHERE run_id = ? AND step_key = 'validate-input'`,
      ).bind(inputJson, inputJson, now, now, now, runId),
      env.DB.prepare(
        `UPDATE execution_steps
            SET status = 'SUCCEEDED', attempt_count = 1, input_json = ?,
                output_json = ?, started_at = ?, completed_at = ?, updated_at = ?
          WHERE run_id = ? AND step_key = 'normalize-content'`,
      ).bind(
        JSON.stringify({ title: VALID_INPUT.title, document: VALID_INPUT.document }),
        JSON.stringify(normalized),
        now,
        now,
        now,
        runId,
      ),
      env.DB.prepare(
        `UPDATE execution_steps
            SET status = 'RUNNING', attempt_count = 1, started_at = ?, updated_at = ?
          WHERE run_id = ? AND step_key = 'extract-insights'`,
      ).bind(now, now, runId),
      env.DB.prepare(
        `UPDATE step_attempts SET status = 'ABANDONED', completed_at = ?
          WHERE run_id = ? AND status = 'RUNNING'`,
      ).bind(now, runId),
    ]);

    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, runId);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });

    // The run is already RUNNING, so the consumer would skip it. Create the
    // instance directly to model workflow recovery after an eviction.
    await env.RUN_WORKFLOW.create({
      id: runId,
      params: { runId, correlationId: "cor_recovery" },
    });
    await instance.waitForStatus("complete");

    const detail = await getRunDetail(session, runId);
    expect(detail.status).toBe("SUCCEEDED");

    const steps = await getSteps(env.DB, runId);
    const byKey = new Map(steps.map((step) => [step.step_key, step]));
    expect(byKey.get("validate-input")?.attempt_count).toBe(1);
    expect(byKey.get("normalize-content")?.attempt_count).toBe(1);
    expect(byKey.get("extract-insights")?.attempt_count).toBe(1);
    expect(byKey.get("validate-output")?.attempt_count).toBe(1);
    expect(byKey.get("persist-result")?.attempt_count).toBe(1);

    // The recovered steps were not re-run: there are no new attempts for them.
    const recoveredAttempts = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM step_attempts a
         JOIN execution_steps s ON s.id = a.step_id
        WHERE a.run_id = ? AND s.step_key IN ('validate-input', 'normalize-content')`,
    )
      .bind(runId)
      .first<{ count: number }>();
    expect(Number(recoveredAttempts?.count)).toBe(0);

    expect(detail.id).toBe(runId);
    expect(dispatchId).toMatch(/^dsp_/u);
  });

  it("rejects a run whose persisted input was tampered with", async () => {
    const session = await createSession();
    const { runId, dispatchId } = await seedRun({ session });

    await env.DB.prepare(`UPDATE runs SET input_json = ? WHERE id = ?`)
      .bind(JSON.stringify({ ...VALID_INPUT, title: "Tampered title" }), runId)
      .run();

    await using instance = await introspectWorkflowInstance(env.RUN_WORKFLOW, runId);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });

    await deliverDispatch(runId, dispatchId);
    await instance.waitForStatus("complete");

    const detail = await getRunDetail(session, runId);
    expect(detail.status).toBe("FAILED");
    expect(detail.error?.class).toBe("EXECUTION_INFRASTRUCTURE");
    expect(detail.error?.code).toBe("INPUT_INTEGRITY_FAILED");
  });
});

async function fetchRetry(
  runId: string,
  session: Parameters<typeof getRunDetail>[0],
): Promise<Awaited<ReturnType<typeof getRunDetail>>> {
  const response = await apiFetch(`/api/runs/${runId}/retry`, { method: "POST" }, session);
  const result = await readSuccess<{ run: Awaited<ReturnType<typeof getRunDetail>> }>(response);
  return result.run;
}
