import { Hono } from "hono";
import { z } from "zod";
import { providerSchema, modelRouteSchema } from "../../../shared/contracts/gateway";
import { ownedProject } from "../../integrations/access";
import { encryptSecret, secretStorageConfigured } from "../../integrations/secrets";
import { callModel } from "../../integrations/gateway";
import { randomId } from "../../lib/crypto";
import { nowIso } from "../../lib/time";
import { parseWith, notFound, conflict } from "../errors";
import { readJsonBody, getRequestContext, type AppEnv } from "../middleware";
export const gatewayRoutes = new Hono<AppEnv>();
gatewayRoutes.get("/projects/:projectId/gateway", async (c) => {
  const { projectId } = await ownedProject(c);
  const credentials = await c.env.DB.prepare(
    "SELECT provider,updated_at FROM provider_credentials WHERE project_id=?",
  )
    .bind(projectId)
    .all();
  const routes = await c.env.DB.prepare(
    "SELECT id,name,revision,config_json FROM model_routes WHERE project_id=? ORDER BY name",
  )
    .bind(projectId)
    .all();
  const requests = await c.env.DB.prepare(
    "SELECT id,route_id,provider,model,status,input_tokens,output_tokens,duration_ms,estimated_cost_usd,attempts_json,created_at FROM model_requests WHERE project_id=? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(projectId)
    .all();
  return c.json({
    data: {
      secretStorageConfigured: secretStorageConfigured(c.env),
      credentials: credentials.results,
      routes: routes.results,
      requests: requests.results,
    },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
gatewayRoutes.put("/projects/:projectId/gateway/credentials/:provider", async (c) => {
  const { projectId } = await ownedProject(c),
    provider = parseWith(providerSchema, c.req.param("provider"), "Unknown provider."),
    body = parseWith(
      z
        .object({
          apiKey: z.string().trim().min(8).max(4096),
          accountId: z
            .string()
            .regex(/^[a-f0-9]{32}$/u)
            .optional(),
        })
        .strict()
        .refine((b) => provider !== "workers" || !!b.accountId),
      await readJsonBody(c),
      "Invalid provider credentials.",
    );
  const ciphertext = await encryptSecret(c.env, JSON.stringify(body), projectId + ":" + provider);
  await c.env.DB.prepare(
    "INSERT INTO provider_credentials (project_id,provider,secret_ciphertext,updated_at) VALUES (?,?,?,?) ON CONFLICT(project_id,provider) DO UPDATE SET secret_ciphertext=excluded.secret_ciphertext,updated_at=excluded.updated_at",
  )
    .bind(projectId, provider, ciphertext, nowIso())
    .run();
  return c.json({
    data: { configured: true },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
gatewayRoutes.delete("/projects/:projectId/gateway/credentials/:provider", async (c) => {
  const { projectId } = await ownedProject(c);
  await c.env.DB.prepare("DELETE FROM provider_credentials WHERE project_id=? AND provider=?")
    .bind(projectId, c.req.param("provider"))
    .run();
  return c.json({ data: { removed: true }, meta: { requestId: getRequestContext(c).requestId } });
});
gatewayRoutes.post("/projects/:projectId/gateway/routes", async (c) => {
  const { projectId } = await ownedProject(c),
    config = parseWith(modelRouteSchema, await readJsonBody(c), "Invalid model route."),
    id = randomId("route"),
    now = nowIso();
  try {
    await c.env.DB.prepare(
      "INSERT INTO model_routes (id,project_id,name,config_json,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(id, projectId, config.name, JSON.stringify(config), now, now)
      .run();
  } catch (error) {
    if (error instanceof Error && /UNIQUE/u.test(error.message))
      throw conflict("ROUTE_NAME_EXISTS", "Choose a unique route name.");
    throw error;
  }
  return c.json(
    { data: { id, revision: 1 }, meta: { requestId: getRequestContext(c).requestId } },
    201,
  );
});
gatewayRoutes.put("/projects/:projectId/gateway/routes/:id", async (c) => {
  const { projectId } = await ownedProject(c),
    b = parseWith(
      z.object({ revision: z.number().int().positive(), config: modelRouteSchema }).strict(),
      await readJsonBody(c),
      "Invalid route update.",
    );
  const r = await c.env.DB.prepare(
    "UPDATE model_routes SET name=?,config_json=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?",
  )
    .bind(
      b.config.name,
      JSON.stringify(b.config),
      nowIso(),
      c.req.param("id"),
      projectId,
      b.revision,
    )
    .run();
  if (!r.meta.changes) throw conflict("ROUTE_CONFLICT", "Reload the route before saving.");
  return c.json({
    data: { revision: b.revision + 1 },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
gatewayRoutes.delete("/projects/:projectId/gateway/routes/:id", async (c) => {
  const { projectId } = await ownedProject(c);
  const r = await c.env.DB.prepare("DELETE FROM model_routes WHERE id=? AND project_id=?")
    .bind(c.req.param("id"), projectId)
    .run();
  if (!r.meta.changes) throw notFound();
  return c.json({ data: { deleted: true }, meta: { requestId: getRequestContext(c).requestId } });
});
gatewayRoutes.post("/projects/:projectId/gateway/playground", async (c) => {
  const { projectId } = await ownedProject(c),
    body = parseWith(
      z.object({ routeId: z.string().max(80), prompt: z.string().min(1).max(10000) }).strict(),
      await readJsonBody(c),
      "Enter a route and prompt.",
    );
  const result = await callModel(c.env, projectId, body.routeId, body.prompt);
  return c.json({ data: result, meta: { requestId: getRequestContext(c).requestId } });
});
