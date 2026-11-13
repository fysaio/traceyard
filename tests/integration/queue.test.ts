import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { randomId } from "../../worker/lib/crypto";
import { getDispatchByRunId } from "../../worker/persistence/dispatches";
import { buildDispatchMessage, publishDispatch } from "../../worker/queue/producer";
import worker from "../../worker/index";
import { createSession, deliverDispatch, seedRun } from "./helpers";

async function deliverRaw(body: unknown): Promise<Awaited<ReturnType<typeof getQueueResult>>> {
  const batch = createMessageBatch("traceyard-executions", [
    {
      id: `msg_${crypto.randomUUID()}`,
      timestamp: Date.now(),
      attempts: 1,
      body,
    },
  ]);
  const context = createExecutionContext();
  await worker.queue(batch, env, context);
  return getQueueResult(batch, context);
}

describe("dispatch outbox", () => {
  it("marks a dispatch as published after a successful queue send", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });

    const pending = await getDispatchByRunId(env.DB, runId);
    expect(pending?.status).toBe("PENDING");
    expect(pending?.attempt_count).toBe(0);

    await publishDispatch(env, env.DB, pending!, "test-request");

    const published = await getDispatchByRunId(env.DB, runId);
    expect(published?.status).toBe("PUBLISHED");
    expect(published?.attempt_count).toBe(1);
    expect(published?.published_at).not.toBeNull();
    expect(published?.last_error).toBeNull();
  });

  it("acknowledges a malformed message without touching a dispatch", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });

    const result = await deliverRaw({ v: 2, runId: "nope" });
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toHaveLength(0);

    const dispatch = await getDispatchByRunId(env.DB, runId);
    expect(dispatch?.status).toBe("PENDING");
  });

  it("acknowledges a message for a run that does not exist", async () => {
    const missingRunId = randomId("run");
    const result = await deliverDispatch(missingRunId, randomId("dsp"));
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toHaveLength(0);
  });

  it("acknowledges a message for a run that is no longer queued", async () => {
    const session = await createSession();
    const { runId, dispatchId } = await seedRun({ session });
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE runs SET status = 'CANCELLED', completed_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(now, now, runId)
      .run();

    const result = await deliverDispatch(runId, dispatchId);
    expect(result.explicitAcks).toHaveLength(1);

    const dispatch = await getDispatchByRunId(env.DB, runId);
    expect(dispatch?.status).toBe("PENDING");
  });

  it("acknowledges a delivery whose dispatch was already claimed", async () => {
    const session = await createSession();
    const { runId, dispatchId } = await seedRun({ session });
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE execution_dispatches SET status = 'CLAIMED', claimed_at = ?, updated_at = ?
        WHERE run_id = ?`,
    )
      .bind(now, now, runId)
      .run();

    const message = buildDispatchMessage(runId, dispatchId);
    const result = await deliverRaw(message);
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toHaveLength(0);

    const dispatch = await getDispatchByRunId(env.DB, runId);
    expect(dispatch?.status).toBe("CLAIMED");
  });
});
