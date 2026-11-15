import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStep } from "cloudflare:workers";
import { graphSchema, graphLayers, evaluateGraphNode } from "../../shared/workflow/graph";
import { DomainError, serializeError } from "../../shared/domain/errors";
import { sha256Hex } from "../lib/crypto";
import { getRunRow, getSteps } from "../persistence/runs";
import { startStepAttempt, completeStep, failStepAttempt } from "../persistence/steps";
import { commitWorkflowOutput } from "../persistence/outputs";
import { beginRun, finalizeRunCancelled, finalizeRunFailure, finalizeRunSuccess } from "./finalize";
import type { RunRow } from "../persistence/rows";

export async function executeGraph(
  db: D1Database,
  run: RunRow,
  graphJson: string,
  step: WorkflowStep,
) {
  const stopped = () =>
    getRunRow(db, run.id).then(
      (r) => !r || ["CANCELLING", "CANCELLED", "FAILED"].includes(r.status),
    );
  try {
    const graph = graphSchema.parse(JSON.parse(graphJson));
    if ((await sha256Hex(run.input_json)) !== run.input_hash)
      throw new Error("Persisted input failed its integrity check.");
    if (run.status === "QUEUED") await beginRun(db, run.id, run.correlation_id);
    const input: unknown = JSON.parse(run.input_json),
      results = new Map<string, unknown>();
    for (const layer of graphLayers(graph)) {
      if (await stopped()) {
        await finalizeRunCancelled(db, run.id);
        return { runId: run.id, status: "CANCELLED" as const };
      }
      const settled = await Promise.allSettled(
        layer.map(async (node) => {
          const incoming = graph.edges
            .filter(([, b]) => b === node.id)
            .map(([a]) => results.get(a));
          const rows = await getSteps(db, run.id),
            record = rows.find((s) => s.step_key === node.id);
          if (!record) throw new Error("Step record missing.");
          const output = await step.do(
            node.id,
            { retries: { limit: 0, delay: 0, backoff: "constant" }, timeout: 10000 },
            async (ctx) => {
              const started = await startStepAttempt(db, {
                runId: run.id,
                stepId: record.id,
                stepKey: node.id,
                attemptNumber: ctx.attempt,
                inputJson: JSON.stringify(node.type === "input" ? input : incoming),
              });
              if (started.state === "already_succeeded") return started.step?.output_json ?? "null";
              if (started.state !== "started")
                throw new NonRetryableError("Step cannot start in its current state.");
              try {
                const value = evaluateGraphNode(node, input, incoming),
                  json = JSON.stringify(value);
                if (new TextEncoder().encode(json).length > 32000)
                  throw new Error("Step output exceeds 32 KB.");
                await completeStep(db, {
                  runId: run.id,
                  stepId: record.id,
                  stepKey: node.id,
                  attemptNumber: ctx.attempt,
                  outputJson: json,
                  eventMessage: `${node.name} completed.`,
                  eventData: {
                    dependencies: graph.edges.filter(([, b]) => b === node.id).map(([a]) => a),
                  },
                });
                return json;
              } catch (error) {
                const failure = serializeError(
                  new DomainError({
                    errorClass: "VALIDATION",
                    code: "GRAPH_STEP_FAILED",
                    message: error instanceof Error ? error.message : "Step failed.",
                    retryable: false,
                  }),
                  { stepKey: node.id, attempt: ctx.attempt },
                );
                await failStepAttempt(db, {
                  runId: run.id,
                  stepId: record.id,
                  stepKey: node.id,
                  stepName: node.name,
                  attemptNumber: ctx.attempt,
                  error: failure,
                  isFinalAttempt: true,
                });
                throw new NonRetryableError(failure.message);
              }
            },
          );
          results.set(node.id, JSON.parse(output) as unknown);
        }),
      );
      const failed = settled.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    if (await stopped()) {
      await finalizeRunCancelled(db, run.id);
      return { runId: run.id, status: "CANCELLED" as const };
    }
    const output = results.get(graph.nodes.find((n) => n.type === "output")!.id),
      json = JSON.stringify(output),
      digest = await sha256Hex(json);
    await step.do("commit-graph-result", async () => {
      await commitWorkflowOutput(db, { runId: run.id, digest, outputJson: json });
    });
    const committed = await finalizeRunSuccess(db, run.id, json, { digest });
    if (!committed) {
      await finalizeRunCancelled(db, run.id);
      return { runId: run.id, status: "CANCELLED" as const };
    }
    return { runId: run.id, status: "SUCCEEDED" as const };
  } catch (error) {
    const failure = serializeError(error);
    await finalizeRunFailure(db, run.id, JSON.stringify(failure), failure.class, failure.message);
    return { runId: run.id, status: "FAILED" as const };
  }
}
