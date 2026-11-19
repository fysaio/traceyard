import { Hono } from "hono";
import { z } from "zod";
import { repositoryPathSchema } from "../../../shared/contracts/repository-index";
import { verificationRequestSchema } from "../../../shared/contracts/verification";
import { ownedProject } from "../../integrations/access";
import {
  createVerification,
  getVerification,
  startFlakinessCheck,
} from "../../services/verification-service";
import { parseWith } from "../errors";
import { readJsonBody, getRequestContext, type AppEnv } from "../middleware";
export function verificationRoutes(fetcher: typeof fetch = fetch) {
  const app = new Hono<AppEnv>();
  app.post("/projects/:projectId/investigations/:id/flakiness", async (c) => {
    const { userId, projectId } = await ownedProject(c);
    const body = parseWith(
      z
        .object({
          commit: z.string().regex(/^[a-f0-9]{40}$/),
          testPath: repositoryPathSchema,
        })
        .strict(),
      await readJsonBody(c),
      "Choose a candidate commit and existing test file.",
    );
    return c.json(
      {
        data: await startFlakinessCheck(
          c.env,
          userId,
          projectId,
          c.req.param("id"),
          body.commit,
          body.testPath,
          fetcher,
        ),
        meta: { requestId: getRequestContext(c).requestId },
      },
      202,
    );
  });
  app.post("/projects/:projectId/investigations/:id/verify", async (c) => {
    const { userId, projectId } = await ownedProject(c),
      b = parseWith(
        verificationRequestSchema,
        await readJsonBody(c),
        "Select an immutable candidate commit.",
      );
    return c.json(
      {
        data: await createVerification(
          c.env,
          userId,
          projectId,
          c.req.param("id"),
          b.commit,
          b.requestKey,
          fetcher,
        ),
        meta: { requestId: getRequestContext(c).requestId },
      },
      202,
    );
  });
  app.get("/projects/:projectId/verifications/:id", async (c) => {
    const { userId, projectId } = await ownedProject(c);
    return c.json({
      data: await getVerification(c.env.DB, userId, projectId, c.req.param("id")),
      meta: { requestId: getRequestContext(c).requestId },
    });
  });
  return app;
}
