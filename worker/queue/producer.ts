import { z } from "zod";

import { log, logError } from "../observability/logger";
import { recordPublishFailure, recordPublishSuccess } from "../persistence/dispatches";
import type { DispatchRow } from "../persistence/rows";
import { isoFromNow } from "../lib/time";

export const dispatchMessageSchema = z
  .object({
    v: z.literal(1),
    runId: z.string().regex(/^run_[a-f0-9]{32}$/),
    dispatchId: z.string().regex(/^dsp_[a-f0-9]{32}$/),
    enqueuedAt: z.string().min(20).max(40),
  })
  .strict();

export type DispatchMessage = z.infer<typeof dispatchMessageSchema>;

export function buildDispatchMessage(runId: string, dispatchId: string): DispatchMessage {
  return { v: 1, runId, dispatchId, enqueuedAt: new Date().toISOString() };
}

/**
 * Publishes a dispatch message. Queue publication is not atomic with the D1
 * insert; a failure is recorded on the dispatch row and the scheduled
 * reconciliation job republishes it. The request still succeeds because the run
 * is durably persisted.
 */
export async function publishDispatch(
  env: Env,
  db: D1Database,
  dispatch: DispatchRow,
  requestId: string,
): Promise<void> {
  const message = buildDispatchMessage(dispatch.run_id, dispatch.id);
  try {
    await env.EXECUTION_QUEUE.send(message);
    await recordPublishSuccess(db, dispatch.id);
    log("info", "dispatch.published", {
      requestId,
      runId: dispatch.run_id,
      dispatchId: dispatch.id,
    });
  } catch (error) {
    logError("dispatch.publish_failed", error, {
      requestId,
      runId: dispatch.run_id,
      dispatchId: dispatch.id,
    });
    try {
      await recordPublishFailure(db, dispatch.id, "Queue publication failed.", isoFromNow(30_000));
    } catch (recordError) {
      logError("dispatch.publish_failure_record_failed", recordError, {
        requestId,
        runId: dispatch.run_id,
      });
    }
  }
}
