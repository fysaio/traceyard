import { Hono } from "hono";
import { z } from "zod";
import { ownedProject } from "../../integrations/access";
import { outboundUrl } from "../../integrations/outbound";
import { encryptSecret, secretStorageConfigured } from "../../integrations/secrets";
import { randomId } from "../../lib/crypto";
import { nowIso } from "../../lib/time";
import { parseWith, notFound } from "../errors";
import { getRequestContext, readJsonBody, type AppEnv } from "../middleware";
export const httpRoutes = new Hono<AppEnv>();
httpRoutes.get("/projects/:projectId/http-connections", async (c) => {
  const { projectId } = await ownedProject(c),
    rows = await c.env.DB.prepare(
      "SELECT id,name,url,method,(secret_ciphertext IS NOT NULL) AS authenticated FROM http_connections WHERE project_id=? ORDER BY name",
    )
      .bind(projectId)
      .all();
  return c.json({
    data: {
      items: rows.results,
      allowedHosts: (c.env.OUTBOUND_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      secretStorageConfigured: secretStorageConfigured(c.env),
    },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
httpRoutes.post("/projects/:projectId/http-connections", async (c) => {
  const { projectId } = await ownedProject(c),
    b = parseWith(
      z
        .object({
          name: z.string().trim().min(1).max(80),
          url: z.string().max(2000),
          method: z.enum(["GET", "POST", "PUT", "PATCH"]),
          token: z.string().min(1).max(4096).optional(),
        })
        .strict(),
      await readJsonBody(c),
      "Enter a name and an allowed HTTPS destination.",
    ),
    id = randomId("connection"),
    url = outboundUrl(c.env, b.url),
    secret = b.token ? await encryptSecret(c.env, b.token, projectId + ":http:" + id) : null;
  await c.env.DB.prepare(
    "INSERT INTO http_connections (id,project_id,name,url,method,secret_ciphertext,created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(id, projectId, b.name, url, b.method, secret, nowIso())
    .run();
  return c.json({ data: { id }, meta: { requestId: getRequestContext(c).requestId } }, 201);
});
httpRoutes.delete("/projects/:projectId/http-connections/:id", async (c) => {
  const { projectId } = await ownedProject(c),
    r = await c.env.DB.prepare("DELETE FROM http_connections WHERE id=? AND project_id=?")
      .bind(c.req.param("id"), projectId)
      .run();
  if (!r.meta.changes) throw notFound();
  return c.json({ data: { deleted: true }, meta: { requestId: getRequestContext(c).requestId } });
});
