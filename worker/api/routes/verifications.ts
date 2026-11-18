import { Hono } from "hono";
import { verificationRequestSchema } from "../../../shared/contracts/verification";
import { ownedProject } from "../../integrations/access";
import { createVerification, getVerification } from "../../services/verification-service";
import { parseWith } from "../errors";
import { readJsonBody, getRequestContext, type AppEnv } from "../middleware";
export function verificationRoutes(fetcher: typeof fetch = fetch) {
  const app = new Hono<AppEnv>();
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
