import { Hono } from "hono";
import { z } from "zod";
import { ownedProject } from "../../integrations/access";
import { outboundUrl } from "../../integrations/outbound";
import { encryptSecret } from "../../integrations/secrets";
import { randomId } from "../../lib/crypto";
import { isoFromNow, nowIso } from "../../lib/time";
import { getRequestContext, readJsonBody, type AppEnv } from "../middleware";
import { badRequest, notFound, parseWith } from "../errors";
import { findWorkflowByIdOrSlug, SANDBOX_PROJECT_ID } from "../../persistence/catalog";
import { assertCatalogMatchesRuntime } from "../../workflows/registry";
export const automationRoutes = new Hono<AppEnv>();
automationRoutes.get("/projects/:projectId/automations", async (c) => {
  const { projectId } = await ownedProject(c);
  const schedules = await c.env.DB.prepare(
    "SELECT * FROM workflow_schedules WHERE project_id=? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(projectId)
    .all();
  const webhooks = await c.env.DB.prepare(
    "SELECT id,url,enabled,created_at FROM outgoing_webhooks WHERE project_id=? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(projectId)
    .all();
  const deliveries = await c.env.DB.prepare(
    "SELECT d.id,d.webhook_id,d.run_id,d.status,d.attempts,d.next_attempt_at,d.response_status,d.last_error FROM webhook_deliveries d JOIN outgoing_webhooks w ON w.id=d.webhook_id WHERE w.project_id=? ORDER BY d.next_attempt_at DESC LIMIT 100",
  )
    .bind(projectId)
    .all();
  return c.json({
    data: {
      schedules: schedules.results,
      webhooks: webhooks.results,
      deliveries: deliveries.results,
      allowedHosts: (c.env.OUTBOUND_ALLOWED_HOSTS ?? "").split(",").filter(Boolean),
    },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
automationRoutes.post("/projects/:projectId/schedules", async (c) => {
  const { projectId, userId } = await ownedProject(c),
    b = parseWith(
      z
        .object({
          workflowId: z.string().max(80),
          version: z.number().int().positive(),
          input: z.unknown(),
          intervalMinutes: z.number().int().min(5).max(10080),
        })
        .strict(),
      await readJsonBody(c),
      "Invalid schedule.",
    );
  const entry =
    (await findWorkflowByIdOrSlug(c.env.DB, b.workflowId, projectId, b.version)) ??
    (await findWorkflowByIdOrSlug(c.env.DB, b.workflowId, SANDBOX_PROJECT_ID, b.version));
  if (!entry) throw notFound("Published version not found.");
  try {
    assertCatalogMatchesRuntime(entry).validateInput(b.input);
  } catch {
    throw badRequest("INVALID_INPUT", "The input does not match the published workflow.");
  }
  const id = randomId("schedule");
  await c.env.DB.prepare(
    "INSERT INTO workflow_schedules (id,project_id,owner_user_id,workflow_id,workflow_version,input_json,interval_minutes,next_run_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      projectId,
      userId,
      entry.workflow.id,
      b.version,
      JSON.stringify(b.input),
      b.intervalMinutes,
      isoFromNow(b.intervalMinutes * 60000),
      nowIso(),
    )
    .run();
  return c.json({ data: { id }, meta: { requestId: getRequestContext(c).requestId } }, 201);
});
automationRoutes.post("/projects/:projectId/webhooks", async (c) => {
  const { projectId } = await ownedProject(c),
    b = parseWith(
      z.object({ url: z.string().max(2000), signingSecret: z.string().min(24).max(200) }).strict(),
      await readJsonBody(c),
      "Provide a destination and a signing secret of at least 24 characters.",
    );
  const url = outboundUrl(c.env, b.url),
    id = randomId("webhook"),
    ciphertext = await encryptSecret(c.env, b.signingSecret, projectId + ":webhook:" + id);
  await c.env.DB.prepare(
    "INSERT INTO outgoing_webhooks (id,project_id,url,secret_ciphertext,created_at) VALUES (?,?,?,?,?)",
  )
    .bind(id, projectId, url, ciphertext, nowIso())
    .run();
  return c.json({ data: { id }, meta: { requestId: getRequestContext(c).requestId } }, 201);
});
for (const resource of ["schedules", "webhooks"] as const) {
  automationRoutes.put("/projects/:projectId/" + resource + "/:id", async (c) => {
    const { projectId } = await ownedProject(c),
      b = parseWith(
        z.object({ enabled: z.boolean() }).strict(),
        await readJsonBody(c),
        "Invalid enable setting.",
      );
    const table = resource === "schedules" ? "workflow_schedules" : "outgoing_webhooks";
    const r = await c.env.DB.prepare(`UPDATE ${table} SET enabled=? WHERE id=? AND project_id=?`)
      .bind(b.enabled ? 1 : 0, c.req.param("id"), projectId)
      .run();
    if (!r.meta.changes) throw notFound();
    return c.json({ data: { updated: true }, meta: { requestId: getRequestContext(c).requestId } });
  });
  automationRoutes.delete("/projects/:projectId/" + resource + "/:id", async (c) => {
    const { projectId } = await ownedProject(c);
    const table = resource === "schedules" ? "workflow_schedules" : "outgoing_webhooks";
    const r = await c.env.DB.prepare(`DELETE FROM ${table} WHERE id=? AND project_id=?`)
      .bind(c.req.param("id"), projectId)
      .run();
    if (!r.meta.changes) throw notFound();
    return c.json({ data: { deleted: true }, meta: { requestId: getRequestContext(c).requestId } });
  });
}
