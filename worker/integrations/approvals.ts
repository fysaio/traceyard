import type { WorkflowStep } from "cloudflare:workers";
import type { GraphNode } from "../../shared/workflow/graph";
import type { RunRow } from "../persistence/rows";
import { randomId } from "../lib/crypto";
import { nowIso, isoFromNow } from "../lib/time";
export async function awaitApproval(
  db: D1Database,
  run: RunRow,
  node: GraphNode,
  payload: unknown,
  step: WorkflowStep,
) {
  const task = await step.do(node.id + "-approval-create", async () => {
    const id = randomId("approval");
    await db
      .prepare(
        "INSERT INTO approval_tasks (id,run_id,node_id,project_id,status,prompt,payload_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,node_id) DO NOTHING",
      )
      .bind(
        id,
        run.id,
        node.id,
        run.project_id,
        "PENDING",
        node.config.prompt ?? "Review the proposed output.",
        JSON.stringify(payload),
        nowIso(),
        isoFromNow((node.config.expiresMinutes ?? 30) * 60000),
      )
      .run();
    return (await db
      .prepare("SELECT id FROM approval_tasks WHERE run_id=? AND node_id=?")
      .bind(run.id, node.id)
      .first<{ id: string }>())!.id;
  });
  for (let i = 0; i <= (node.config.expiresMinutes ?? 30) + 1; i++) {
    const state = await step.do(node.id + "-approval-check-" + i, async () => {
      const r = await db
        .prepare("SELECT status FROM runs WHERE id=?")
        .bind(run.id)
        .first<{ status: string }>();
      if (r && ["CANCELLING", "CANCELLED"].includes(r.status))
        await db
          .prepare(
            "UPDATE approval_tasks SET status='CANCELLED',decided_at=? WHERE id=? AND status='PENDING'",
          )
          .bind(nowIso(), task)
          .run();
      await db
        .prepare(
          "UPDATE approval_tasks SET status='EXPIRED',decided_at=? WHERE id=? AND status='PENDING' AND expires_at<=?",
        )
        .bind(nowIso(), task, nowIso())
        .run();
      return (await db
        .prepare("SELECT status FROM approval_tasks WHERE id=?")
        .bind(task)
        .first<{ status: string }>())!.status;
    });
    if (state === "APPROVED") return payload;
    if (state !== "PENDING") throw new Error("Approval " + state.toLowerCase() + ".");
    try {
      await step.waitForEvent(node.id + "-approval-wait-" + i, {
        type: "approval:" + task,
        timeout: "1 minute",
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "WorkflowTimeoutError") throw error;
    }
  }
  throw new Error("Approval expired.");
}
export async function wakeApprovals(env: Env, runId: string) {
  const tasks = await env.DB.prepare(
    "SELECT id FROM approval_tasks WHERE run_id=? AND status='PENDING'",
  )
    .bind(runId)
    .all<{ id: string }>();
  for (const task of tasks.results)
    try {
      const instance = await env.RUN_WORKFLOW.get(runId);
      await instance.sendEvent({ type: "approval:" + task.id, payload: { checkStatus: true } });
    } catch {
      /* Persisted cancellation is also observed at the next wait timeout. */
    }
}
