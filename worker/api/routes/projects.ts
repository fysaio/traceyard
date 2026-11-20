import { Hono } from "hono";
import { z } from "zod";

import { createOwnedProject, getOwnedProject, listOwnedProjects } from "../../persistence/projects";
import { getRequestContext, type AppEnv } from "../middleware";
import { notFound, parseWith, unauthorized } from "../errors";
import { readJsonBody } from "../middleware";

const createProjectSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.get("/projects", async (c) => {
  const auth = c.get("auth");
  if (auth === null)
    throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to view your projects.");
  const requestId = getRequestContext(c).requestId;
  const projects = await listOwnedProjects(c.env.DB, auth.user.id);
  return c.json({ data: { items: projects }, meta: { requestId } });
});

projectRoutes.post("/projects", async (c) => {
  const auth = c.get("auth");
  if (auth === null) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to create a project.");
  const body = parseWith(
    createProjectSchema,
    await readJsonBody(c),
    "The project details are invalid.",
  );
  const project = await createOwnedProject(c.env.DB, auth.user.id, body.name);
  return c.json({ data: project, meta: { requestId: getRequestContext(c).requestId } }, 201);
});

projectRoutes.patch("/projects/:projectId", async (c) => {
  const auth = c.get("auth");
  if (!auth) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to edit projects.");
  const p = await getOwnedProject(c.env.DB, auth.user.id, c.req.param("projectId"));
  if (!p) throw notFound("Project not found.");
  const b = parseWith(createProjectSchema, await readJsonBody(c), "Enter a project name.");
  await c.env.DB.prepare("UPDATE projects SET name=? WHERE id=? AND owner_user_id=?")
    .bind(b.name, p.id, auth.user.id)
    .run();
  return c.json({
    data: { ...p, name: b.name },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
projectRoutes.get("/projects/:projectId/connection-status", async (c) => {
  const auth = c.get("auth");
  if (!auth) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to view project connections.");
  const p = await getOwnedProject(c.env.DB, auth.user.id, c.req.param("projectId"));
  if (!p) throw notFound("Project not found.");
  const [keys, traces] = await Promise.all([
    c.env.DB.prepare(
      "SELECT COUNT(*) AS count,MAX(last_used_at) AS last_used_at FROM api_keys WHERE project_id=? AND revoked_at IS NULL AND expires_at>?",
    )
      .bind(p.id, new Date().toISOString())
      .first<{ count: number; last_used_at: string | null }>(),
    c.env.DB.prepare(
      "SELECT COUNT(DISTINCT trace_id) AS count,MAX(received_at) AS last_received_at FROM trace_spans WHERE project_id=?",
    )
      .bind(p.id)
      .first<{ count: number; last_received_at: string | null }>(),
  ]);
  return c.json({
    data: {
      project: p,
      activeKeys: keys?.count ?? 0,
      lastKeyUsedAt: keys?.last_used_at ?? null,
      traces: traces?.count ?? 0,
      lastTraceReceivedAt: traces?.last_received_at ?? null,
    },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
