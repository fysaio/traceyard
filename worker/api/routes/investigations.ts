import { Hono } from "hono";
import { z } from "zod";
import { investigationRequestSchema } from "../../../shared/contracts/investigations";
import { ownedProject } from "../../integrations/access";
import {
  getInvestigation,
  inspectEvidence,
  listInvestigations,
} from "../../services/investigation-service";
import { getRequestContext, readJsonBody, type AppEnv } from "../middleware";
import { parseWith } from "../errors";
import { beginInvestigation } from "../../services/investigation-execution";
import { resolveCiRevision } from "../../services/ci-revision";

export const investigationRoutes = new Hono<AppEnv>();
export function investigationCiRoutes(fetcher: typeof fetch = fetch) {
  const app = new Hono<AppEnv>();
  app.post("/projects/:projectId/investigations/ci-revision", async (c) => {
    const { projectId } = await ownedProject(c);
    const { url } = parseWith(
      z.object({ url: z.string().trim().max(500) }).strict(),
      await readJsonBody(c),
      "Paste a GitHub Actions run or job link.",
    );
    return c.json(payload(c, await resolveCiRevision(c.env, projectId, url, fetcher)));
  });
  return app;
}
const payload = (c: Parameters<typeof getRequestContext>[0], data: unknown) => ({
  data,
  meta: { requestId: getRequestContext(c).requestId },
});
investigationRoutes.get("/projects/:projectId/investigations", async (c) => {
  const { userId, projectId } = await ownedProject(c);
  return c.json(payload(c, { items: await listInvestigations(c.env.DB, userId, projectId) }));
});
investigationRoutes.post("/projects/:projectId/investigations", async (c) => {
  const { userId, projectId } = await ownedProject(c);
  const body = parseWith(
    investigationRequestSchema,
    await readJsonBody(c),
    "Invalid investigation request.",
  );
  return c.json(payload(c, await beginInvestigation(c.env, userId, projectId, body)), 201);
});
investigationRoutes.get("/projects/:projectId/investigations/:id", async (c) => {
  const { userId, projectId } = await ownedProject(c);
  return c.json(payload(c, await getInvestigation(c.env.DB, userId, projectId, c.req.param("id"))));
});
investigationRoutes.get(
  "/projects/:projectId/investigations/:id/evidence/:evidenceId",
  async (c) => {
    const { userId, projectId } = await ownedProject(c);
    const q = parseWith(
      z
        .object({
          offset: z.coerce.number().int().min(0).max(100000).default(0),
          limit: z.coerce.number().int().min(100).max(12000).default(3000),
        })
        .strict(),
      c.req.query(),
      "Invalid evidence range.",
    );
    return c.json(
      payload(
        c,
        await inspectEvidence(
          c.env.DB,
          userId,
          projectId,
          c.req.param("id"),
          c.req.param("evidenceId"),
          q.offset,
          q.limit,
        ),
      ),
    );
  },
);
