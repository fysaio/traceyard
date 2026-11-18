import { Hono } from "hono";
import { z } from "zod";
import { investigationReportSchema } from "../../../shared/contracts/investigation-execution";
import { repositoryPathSchema } from "../../../shared/contracts/repository-index";
import { ownedProject } from "../../integrations/access";
import { runnerPrincipal } from "../../repositories/runner-auth";
import {
  recordInvestigationReport,
  startInvestigationExecution,
  cancelInvestigationExecution,
} from "../../services/investigation-execution";
import { getRequestContext, readJsonBody, type AppEnv } from "../middleware";
import { badRequest, parseWith } from "../errors";
export function investigationExecutionRoutes(fetcher: typeof fetch = fetch) {
  const app = new Hono<AppEnv>();
  app.post("/projects/:projectId/investigations/:id/execute", async (c) => {
    const { userId, projectId } = await ownedProject(c);
    const body = parseWith(
      z.object({ testPath: repositoryPathSchema.optional() }).strict(),
      await readJsonBody(c),
      "Select a supported existing test.",
    );
    return c.json(
      {
        data: await startInvestigationExecution(
          c.env,
          userId,
          projectId,
          c.req.param("id"),
          body,
          fetcher,
        ),
        meta: { requestId: getRequestContext(c).requestId },
      },
      202,
    );
  });
  app.post("/projects/:projectId/investigations/:id/cancel", async (c) => {
    const { userId, projectId } = await ownedProject(c);
    return c.json({
      data: await cancelInvestigationExecution(
        c.env,
        userId,
        projectId,
        c.req.param("id"),
        fetcher,
      ),
      meta: { requestId: getRequestContext(c).requestId },
    });
  });
  app.post("/v1/investigations/:id/report", async (c) => {
    const who = await runnerPrincipal(c, fetcher),
      body = parseWith(
        investigationReportSchema,
        await readJsonBody(c),
        "Invalid focused test evidence.",
      );
    if (who.runId && who.runId !== body.runId)
      throw badRequest("INVESTIGATION_RUNNER_MISMATCH", "This report belongs to another runner.");
    await recordInvestigationReport(c.env.DB, who.projectId, c.req.param("id"), body);
    return c.json({
      data: { received: true },
      meta: { requestId: getRequestContext(c).requestId },
    });
  });
  return app;
}
