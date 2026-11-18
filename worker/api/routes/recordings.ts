import { Hono } from "hono";
import { z } from "zod";
import { recordingManifestSchema } from "../../../shared/contracts/recordings";
import { runnerPrincipal } from "../../repositories/runner-auth";
import { ownedProject } from "../../integrations/access";
import { saveRecording, getRecording } from "../../services/recording-service";
import { readJsonBody, type AppEnv } from "../middleware";
import { badRequest, parseWith } from "../errors";
export function recordingRoutes(fetcher: typeof fetch = fetch) {
  const app = new Hono<AppEnv>();
  app.post("/v1/investigations/:id/recordings", async (c) => {
    const who = await runnerPrincipal(c, fetcher),
      body = parseWith(
        z
          .object({
            requestId: z.string().regex(/^req_[a-f0-9]{32}$/),
            runId: z.string().max(100),
            manifest: recordingManifestSchema,
          })
          .strict(),
        await readJsonBody(c),
        "Invalid interaction recording.",
      );
    if (who.runId && who.runId !== body.runId)
      throw badRequest("RECORDING_RUNNER_MISMATCH", "The recording belongs to another runner.");
    return c.json({
      data: await saveRecording(
        c.env.DB,
        who.projectId,
        c.req.param("id"),
        body.requestId,
        body.runId,
        body.manifest,
      ),
    });
  });
  app.get("/projects/:projectId/recordings/:id", async (c) => {
    const { userId, projectId } = await ownedProject(c);
    return c.json({ data: await getRecording(c.env.DB, userId, projectId, c.req.param("id")) });
  });
  return app;
}
