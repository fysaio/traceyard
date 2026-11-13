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

const createProjectSchema = z
  .object({ name: z.string().trim().min(1).max(80) })
  .strict();

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
  if (auth === null) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to view your projects.");
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
  return c.json(
    { data: project, meta: { requestId: getRequestContext(c).requestId } },
    201,
  );
});

projectRoutes.get("/projects/:projectId/workflows", async (c) => {
  const auth = c.get("auth");
  if (auth === null) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to view saved workflows.");
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
  return c.json(
    { data: workflow, meta: { requestId: getRequestContext(c).requestId } },
    201,
  );
});

projectRoutes.get("/projects/:projectId/workflows/:workflowId", async (c) => {
  const auth = c.get("auth");
  if (auth === null) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to view saved workflows.");
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
