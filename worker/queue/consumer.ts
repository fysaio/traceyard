import { getRunRow } from "../persistence/runs";
import { claimDispatch, getDispatchByRunId, reopenDispatch } from "../persistence/dispatches";
import type { DispatchMessage } from "./producer";
import { dispatchMessageSchema, buildDispatchMessage } from "./producer";
import { log, logError } from "../observability/logger";

/**
 * Queue consumer for execution dispatch messages.
 *
 * Delivery is at-least-once. Idempotency is enforced twice:
 *  1. The dispatch row is claimed with a conditional UPDATE.
 *  2. Workflow instance IDs are the run IDs, so a duplicate create cannot
 *     create a second execution.
 */
export async function handleQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = dispatchMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      log("warn", "queue.invalid_message", { messageId: message.id });
      message.ack();
      continue;
    }
    try {
      const outcome = await handleDispatchMessage(parsed.data, env, message.attempts);
      if (outcome === "retry") {
        message.retry({ delaySeconds: 10 });
      } else {
        message.ack();
      }
    } catch (error) {
      logError("queue.consumer_error", error, {
        messageId: message.id,
        runId: parsed.data.runId,
      });
      message.retry({ delaySeconds: 15 });
    }
  }
}

async function handleDispatchMessage(
  message: DispatchMessage,
  env: Env,
  deliveryAttempt: number,
): Promise<"ack" | "retry"> {
  const run = await getRunRow(env.DB, message.runId);
  if (run === null) {
    log("warn", "dispatch.run_missing", { runId: message.runId, dispatchId: message.dispatchId });
    return "ack";
  }

  if (run.status !== "QUEUED") {
    log("info", "dispatch.run_not_queued", {
      runId: run.id,
      status: run.status,
      deliveryAttempt,
    });
    return "ack";
  }

  if (
    run.scenario !== "success" &&
    run.scenario !== "retryable_failure" &&
    run.scenario !== "terminal_failure"
  ) {
    log("warn", "dispatch.invalid_scenario", { runId: run.id, scenario: run.scenario });
    return "ack";
  }

  const claimed = await claimDispatch(env.DB, run.id);
  if (!claimed) {
    const dispatch = await getDispatchByRunId(env.DB, run.id);
    log("info", "dispatch.duplicate_delivery", {
      runId: run.id,
      dispatchStatus: dispatch?.status ?? "missing",
      deliveryAttempt,
    });
    return "ack";
  }

  try {
    await env.RUN_WORKFLOW.create({
      id: run.id,
      params: { runId: run.id, correlationId: run.correlation_id },
    });
    log("info", "dispatch.workflow_created", {
      runId: run.id,
      correlationId: run.correlation_id,
      deliveryAttempt,
    });
    return "ack";
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      log("info", "dispatch.workflow_already_exists", { runId: run.id });
      return "ack";
    }
    logError("dispatch.workflow_create_failed", error, {
      runId: run.id,
      deliveryAttempt,
    });
    await reopenDispatch(env.DB, run.id, "Workflow instance creation failed.");
    return deliveryAttempt < 3 ? "retry" : "ack";
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /already exists|already been created|instance.*exists/iu.test(error.message);
}

/**
 * Used by tests and the reconciliation job without going through a queue
 * message. It deliberately reuses the same idempotent path.
 */
export async function dispatchRunDirectly(
  env: Env,
  runId: string,
  dispatchId: string,
): Promise<"ack" | "retry"> {
  return handleDispatchMessage(buildDispatchMessage(runId, dispatchId), env, 1);
}
