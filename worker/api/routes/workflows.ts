import { getOwnedProject } from "../../persistence/projects";
import { notFound, unauthorized } from "../errors";
import { Hono } from "hono";

import type { WorkflowSummary } from "../../../shared/contracts/api";
import {
  listWorkflowCatalog,
  findWorkflowByIdOrSlug,
  SANDBOX_PROJECT_ID,
} from "../../persistence/catalog";
import { getRequestContext, type AppEnv } from "../middleware";

export const workflowRoutes = new Hono<AppEnv>();

workflowRoutes.get("/workflows", async (c) => {
  const { requestId } = getRequestContext(c);
  const projectId = c.req.query("projectId");
  if (projectId) {
    const user = c.get("auth");
    if (!user) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to access projects.");
    if (!(await getOwnedProject(c.env.DB, user.user.id, projectId)))
      throw notFound("Project not found.");
  }
  const entries = [
    ...(await listWorkflowCatalog(c.env.DB)),
    ...(projectId ? await listWorkflowCatalog(c.env.DB, projectId) : []),
  ];
  const items: WorkflowSummary[] = entries.map((entry) => entry.summary);
  return c.json({ data: { items }, meta: { requestId } });
});

workflowRoutes.get("/workflows/:id", async (c) => {
  const { requestId } = getRequestContext(c);
  const projectId = c.req.query("projectId");
  if (projectId) {
    const user = c.get("auth");
    if (!user) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to access projects.");
    if (!(await getOwnedProject(c.env.DB, user.user.id, projectId)))
      throw notFound("Project not found.");
  }
  const rawVersion = c.req.query("version"),
    version = rawVersion ? Number(rawVersion) : undefined;
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1))
    throw notFound("Version not found.");
  const id = c.req.param("id");
  const entry =
    (projectId ? await findWorkflowByIdOrSlug(c.env.DB, id, projectId, version) : null) ??
    (await findWorkflowByIdOrSlug(c.env.DB, id, SANDBOX_PROJECT_ID, version));
  if (entry === null) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "The requested workflow does not exist in this project.",
          requestId,
        },
      },
      404,
    );
  }
  return c.json({ data: entry.summary, meta: { requestId } });
});
