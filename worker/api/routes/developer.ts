import { wakeApprovals } from "../../integrations/approvals";
import { Hono } from "hono";
import { launchRunRequestSchema, runListQuerySchema } from "../../../shared/contracts/api";
import { keyPrincipal, keySession } from "../../integrations/access";
import {
  launchRun,
  listRunsForSession,
  getRunDetailForSession,
  cancelRun,
} from "../../services/run-service";
import { decodeRunCursor } from "../../../shared/domain/cursor";
import { badRequest, notFound, parseWith } from "../errors";
import { getRequestContext, readJsonBody, type AppEnv } from "../middleware";
export const developerRoutes = new Hono<AppEnv>();
developerRoutes.post("/v1/runs", async (c) => {
  const key = await keyPrincipal(c, "runs:write"),
    body = parseWith(launchRunRequestSchema, await readJsonBody(c), "Invalid execution request.");
  if (body.projectId && body.projectId !== key.projectId) throw notFound("Project not found.");
  const idempotencyKey = c.req.header("idempotency-key");
  if (!idempotencyKey || !/^[A-Za-z0-9._-]{8,128}$/u.test(idempotencyKey))
    throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "Provide an 8–128 character Idempotency-Key.");
  const request = getRequestContext(c);
  const r = await launchRun(c.env, {
    session: await keySession(c, key),
    userId: key.userId,
    requestId: request.requestId,
    body: { ...body, projectId: key.projectId },
    idempotencyKey,
    config: request.config,
  });
  return c.json(
    { data: r.result, meta: { requestId: request.requestId, replayed: r.replayed } },
    r.status,
  );
});
developerRoutes.get("/v1/runs", async (c) => {
  const key = await keyPrincipal(c, "runs:read"),
    q = parseWith(
      runListQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
      "Invalid list query.",
    );
  if (q.projectId && q.projectId !== key.projectId) throw notFound();
  const cursor = q.cursor ? decodeRunCursor(q.cursor) : null;
  if (q.cursor && !cursor) throw badRequest("INVALID_CURSOR", "Invalid pagination cursor.");
  const r = await listRunsForSession(
    c.env.DB,
    (await keySession(c, key)).idHash,
    { ...q, projectId: key.projectId, cursor },
    key.userId,
  );
  return c.json({ data: r, meta: { requestId: getRequestContext(c).requestId } });
});
async function scopedRun(c: Parameters<typeof keyPrincipal>[0], scope: string) {
  const key = await keyPrincipal(c, scope),
    row = await c.env.DB.prepare(
      "SELECT id FROM runs WHERE id=? AND project_id=? AND owner_user_id=?",
    )
      .bind(c.req.param("id"), key.projectId, key.userId)
      .first();
  if (!row) throw notFound("Execution not found.");
  return key;
}
developerRoutes.get("/v1/runs/:id", async (c) => {
  const key = await scopedRun(c, "runs:read");
  const data = await getRunDetailForSession(
    c.env.DB,
    c.req.param("id"),
    (await keySession(c, key)).idHash,
    key.userId,
  );
  return c.json({ data, meta: { requestId: getRequestContext(c).requestId } });
});
developerRoutes.post("/v1/runs/:id/cancel", async (c) => {
  const key = await scopedRun(c, "runs:write"),
    r = getRequestContext(c);
  const data = await cancelRun(
    c.env.DB,
    (await keySession(c, key)).idHash,
    c.req.param("id"),
    r.requestId,
    key.userId,
  );
  await wakeApprovals(c.env, c.req.param("id"));
  return c.json({ data, meta: { requestId: r.requestId } });
});
