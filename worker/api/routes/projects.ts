import { Hono } from "hono";
import { z } from "zod";

import {
  createOwnedProject,
  createSavedWorkflow,
  deleteSavedWorkflow,
  getOwnedProject,
  getSavedWorkflow,
  listOwnedProjects,
  listSavedWorkflows,
} from "../../persistence/projects";
import { getRequestContext, type AppEnv } from "../middleware";
import { badRequest, notFound, parseWith, unauthorized } from "../errors";
import { readJsonBody } from "../middleware";

const createProjectSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

const createSavedWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(""),
    definition: z.record(z.string(), z.unknown()),
  })
  .strict();

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
  const [keys, traces, workflows, runs] = await Promise.all([
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
    c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM workflows WHERE project_id=? AND archived_at IS NULL",
    )
      .bind(p.id)
      .first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM runs WHERE project_id=?")
      .bind(p.id)
      .first<{ count: number }>(),
  ]);
  return c.json({
    data: {
      project: p,
      activeKeys: keys?.count ?? 0,
      lastKeyUsedAt: keys?.last_used_at ?? null,
      traces: traces?.count ?? 0,
      lastTraceReceivedAt: traces?.last_received_at ?? null,
      workflows: workflows?.count ?? 0,
      executions: runs?.count ?? 0,
    },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
projectRoutes.get("/projects/:projectId/workflows", async (c) => {
  const auth = c.get("auth");
  if (auth === null)
    throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to view saved workflows.");
  const projectId = c.req.param("projectId");
  const project = await getOwnedProject(c.env.DB, auth.user.id, projectId);
  if (project === null) throw notFound("The project was not found.");
  const workflows = await listSavedWorkflows(c.env.DB, auth.user.id, projectId);
  return c.json({
    data: { project, items: workflows },
    meta: { requestId: getRequestContext(c).requestId },
  });
});

projectRoutes.post("/projects/:projectId/workflows", async (c) => {
  const auth = c.get("auth");
  if (auth === null) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to save a workflow.");
  const projectId = c.req.param("projectId");
  const project = await getOwnedProject(c.env.DB, auth.user.id, projectId);
  if (project === null) throw notFound("The project was not found.");
  const body = parseWith(
    createSavedWorkflowSchema,
    await readJsonBody(c),
    "The saved workflow details are invalid.",
  );
  const definitionBytes = new TextEncoder().encode(JSON.stringify(body.definition)).byteLength;
  if (definitionBytes > 24 * 1024) {
    throw badRequest("WORKFLOW_DEFINITION_TOO_LARGE", "Workflow definitions are limited to 24 KB.");
  }
  const workflow = await createSavedWorkflow(c.env.DB, {
    userId: auth.user.id,
    projectId,
    name: body.name,
    description: body.description,
    definition: body.definition,
  });
  return c.json({ data: workflow, meta: { requestId: getRequestContext(c).requestId } }, 201);
});

projectRoutes.get("/projects/:projectId/workflows/:workflowId", async (c) => {
  const auth = c.get("auth");
  if (auth === null)
    throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to view saved workflows.");
  const projectId = c.req.param("projectId");
  const project = await getOwnedProject(c.env.DB, auth.user.id, projectId);
  if (project === null) throw notFound("The project was not found.");
  const workflow = await getSavedWorkflow(
    c.env.DB,
    auth.user.id,
    projectId,
    c.req.param("workflowId"),
  );
  if (workflow === null) throw notFound("The saved workflow was not found.");
  return c.json({
    data: workflow,
    meta: { requestId: getRequestContext(c).requestId },
  });
});

projectRoutes.delete("/projects/:projectId/workflows/:workflowId", async (c) => {
  const auth = c.get("auth");
  if (auth === null) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to delete a workflow.");
  const projectId = c.req.param("projectId");
  const deleted = await deleteSavedWorkflow(
    c.env.DB,
    auth.user.id,
    projectId,
    c.req.param("workflowId"),
  );
  if (!deleted) throw notFound("The saved workflow was not found in this project.");
  return c.json({
    data: { deleted: true },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
