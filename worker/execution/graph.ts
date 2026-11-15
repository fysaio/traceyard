import { nowIso } from "../lib/time";
import { callModel } from "../integrations/gateway";
import { modelRouteSchema } from "../../shared/contracts/gateway";
import { awaitApproval } from "../integrations/approvals";
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
  env: Env,
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
      results = new Map<string, unknown>(),
      skipped = new Set<string>(),
      blocked = new Set<string>();
    for (const layer of graphLayers(graph)) {
      if (await stopped()) {
        await finalizeRunCancelled(db, run.id);
        return { runId: run.id, status: "CANCELLED" as const };
      }
      const settled = await Promise.allSettled(
        layer.map(async (node) => {
          const sources = graph.edges
            .filter(([, b]) => b === node.id)
            .filter(([a]) => !skipped.has(a) && !blocked.has(a + ":" + node.id));
          if (node.type !== "input" && !sources.length) {
            await step.do(node.id + "-skip", async () => {
              await db
                .prepare(
                  "UPDATE execution_steps SET status='SKIPPED',completed_at=?,updated_at=? WHERE run_id=? AND step_key=? AND status='PENDING'",
                )
                .bind(nowIso(), nowIso(), run.id, node.id)
                .run();
            });
            skipped.add(node.id);
            return;
          }
          const incoming = sources.map(([a]) => results.get(a));
          const rows = await getSteps(db, run.id),
            record = rows.find((s) => s.step_key === node.id);
          if (!record) throw new Error("Step record missing.");
          let approval: unknown;
          if (node.type === "approval") {
            await step.do(node.id + "-approval-start", async () => {
              await startStepAttempt(db, {
                runId: run.id,
                stepId: record.id,
                stepKey: node.id,
                attemptNumber: 1,
                inputJson: JSON.stringify(incoming),
              });
            });
            try {
              approval = await awaitApproval(
                db,
                run,
                node,
                incoming.length === 1 ? incoming[0] : incoming,
                step,
              );
            } catch (error) {
              const current = await getRunRow(db, run.id);
              if (current && ["CANCELLING", "CANCELLED"].includes(current.status)) throw error;
              await step.do(node.id + "-approval-failure", async () => {
                await failStepAttempt(db, {
                  runId: run.id,
                  stepId: record.id,
                  stepKey: node.id,
                  stepName: node.name,
                  attemptNumber: 1,
                  isFinalAttempt: true,
                  error: {
                    class: "PERMANENT_APPLICATION",
                    code: "APPROVAL_STOPPED",
                    message: error instanceof Error ? error.message : "Approval stopped.",
                    retryable: false,
                  },
                });
              });
              throw error;
            }
          }
          const output = await step.do(
            node.id,
            {
              retries: { limit: 0, delay: 0, backoff: "constant" },
              timeout: node.type === "model" ? 120000 : 10000,
            },
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
                let value: unknown;
                if (node.type === "approval") value = approval;
                else if (node.type === "model") {
                  const snapshot = await db
                    .prepare(
                      "SELECT route_json,route_id FROM run_model_routes WHERE run_id=? AND node_id=?",
                    )
                    .bind(run.id, node.id)
                    .first<{ route_json: string; route_id: string }>();
                  if (!snapshot) throw new Error("Captured model route is missing.");
                  const result = await callModel(
                    env,
                    run.project_id,
                    snapshot.route_id,
                    (node.config.prompt ?? "") + "\n" + JSON.stringify(incoming),
                    {
                      runId: run.id,
                      stepKey: node.id,
                      route: modelRouteSchema.parse(JSON.parse(snapshot.route_json)),
                    },
                  );
                  value = {
                    text: result.text,
                    provider: result.provider,
                    model: result.model,
                    requestId: result.requestId,
                    usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
                  };
                } else value = evaluateGraphNode(node, input, incoming);
                const json = JSON.stringify(value);
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
          const value: unknown = JSON.parse(output);
          results.set(node.id, value);
          if (node.type === "condition")
            blocked.add(
              node.id + ":" + (value === true ? node.config.elseTarget : node.config.thenTarget),
            );
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
    const current = await getRunRow(db, run.id);
    if (current && ["CANCELLING", "CANCELLED"].includes(current.status)) {
      await finalizeRunCancelled(db, run.id);
      return { runId: run.id, status: "CANCELLED" as const };
    }
    const failure = serializeError(error);
    await finalizeRunFailure(db, run.id, JSON.stringify(failure), failure.class, failure.message);
    return { runId: run.id, status: "FAILED" as const };
  }
}
