import { Hono } from "hono";

import type { WorkflowSummary } from "../../../shared/contracts/api";
import { listWorkflowCatalog } from "../../persistence/catalog";
import { getRequestContext, type AppEnv } from "../middleware";

export const workflowRoutes = new Hono<AppEnv>();

workflowRoutes.get("/workflows", async (c) => {
  const { requestId } = getRequestContext(c);
  const entries = await listWorkflowCatalog(c.env.DB);
  const items: WorkflowSummary[] = entries.map((entry) => entry.summary);
  return c.json({ data: { items }, meta: { requestId } });
});

workflowRoutes.get("/workflows/:id", async (c) => {
  const { requestId } = getRequestContext(c);
  const entries = await listWorkflowCatalog(c.env.DB);
  const id = c.req.param("id");
  const entry = entries.find(
    (candidate) => candidate.workflow.id === id || candidate.workflow.slug === id,
  );
  if (entry === undefined) {
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
