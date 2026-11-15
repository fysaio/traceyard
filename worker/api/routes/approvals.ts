import { Hono } from "hono";
import { z } from "zod";
import { ownedProject } from "../../integrations/access";
import { nowIso } from "../../lib/time";
import { conflict, parseWith } from "../errors";
import { getRequestContext, readJsonBody, type AppEnv } from "../middleware";
export const approvalRoutes = new Hono<AppEnv>();
approvalRoutes.get("/projects/:projectId/approvals", async (c) => {
  const { projectId } = await ownedProject(c);
  await c.env.DB.prepare(
    "UPDATE approval_tasks SET status='EXPIRED',decided_at=? WHERE project_id=? AND status='PENDING' AND expires_at<=?",
  )
    .bind(nowIso(), projectId, nowIso())
    .run();
  const rows = await c.env.DB.prepare(
    "SELECT * FROM approval_tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(projectId)
    .all();
  return c.json({
    data: { items: rows.results },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
approvalRoutes.post("/projects/:projectId/approvals/:id/decision", async (c) => {
  const { projectId, userId } = await ownedProject(c),
    body = parseWith(
      z
        .object({
          decision: z.enum(["APPROVED", "REJECTED"]),
          note: z.string().max(1000).default(""),
        })
        .strict(),
      await readJsonBody(c),
      "Invalid approval decision.",
    );
  const r = await c.env.DB.prepare(
    "UPDATE approval_tasks SET status=?,decision_by=?,decision_note=?,decided_at=? WHERE id=? AND project_id=? AND status='PENDING' AND expires_at>? AND EXISTS(SELECT 1 FROM runs WHERE id=approval_tasks.run_id AND status IN ('QUEUED','RUNNING'))",
  )
    .bind(body.decision, userId, body.note, nowIso(), c.req.param("id"), projectId, nowIso())
    .run();
  if (!r.meta.changes)
    throw conflict(
      "APPROVAL_UNAVAILABLE",
      "This approval is expired, cancelled, already decided or inaccessible.",
    );
  const task = await c.env.DB.prepare(
    "SELECT run_id FROM approval_tasks WHERE id=? AND project_id=?",
  )
    .bind(c.req.param("id"), projectId)
    .first<{ run_id: string }>();
  if (task)
    try {
      const instance = await c.env.RUN_WORKFLOW.get(task.run_id);
      await instance.sendEvent({
        type: "approval:" + c.req.param("id"),
        payload: { decided: true },
      });
    } catch {
      /* Persisted decisions are also observed at the next wait timeout. */
    }
  return c.json({ data: { decided: true }, meta: { requestId: getRequestContext(c).requestId } });
});
