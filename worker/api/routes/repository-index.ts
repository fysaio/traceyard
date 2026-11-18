import { Hono } from "hono";
import { z } from "zod";
import {
  repositoryIndexManifestSchema,
  indexedFileSchema,
  repositoryPathSchema,
} from "../../../shared/contracts/repository-index";
import {
  beginRepositoryIndex,
  uploadRepositoryIndexFiles,
  completeRepositoryIndex,
  getRepositoryIndex,
} from "../../services/repository-index-service";
import { ownedProject } from "../../integrations/access";
import { runnerPrincipal, runnerRevision } from "../../repositories/runner-auth";
import { badRequest, parseWith } from "../errors";
import { getRequestContext, readJsonBody, type AppEnv } from "../middleware";

export function repositoryIndexRoutes(fetcher: typeof fetch = fetch) {
  const routes = new Hono<AppEnv>();
  routes.get("/projects/:projectId/repository/index", async (c) => {
    const { userId, projectId } = await ownedProject(c);
    const q = parseWith(
      z
        .object({
          kind: z.literal("tests").optional(),
          path: repositoryPathSchema.optional(),
          commit: z
            .string()
            .regex(/^[a-f0-9]{40}$/)
            .optional(),
        })
        .strict(),
      c.req.query(),
      "Invalid index query.",
    );
    return c.json({
      data: await getRepositoryIndex(
        c.env.DB,
        userId,
        projectId,
        q.path,
        q.commit,
        q.kind === "tests",
      ),
      meta: { requestId: getRequestContext(c).requestId },
    });
  });
  routes.post("/v1/repository/index", async (c) => {
    const principal = await runnerPrincipal(c, fetcher);
    const revision = await runnerRevision(c, principal);
    const body = parseWith(
      z.discriminatedUnion("action", [
        z.object({ action: z.literal("begin"), manifest: repositoryIndexManifestSchema }).strict(),
        z
          .object({
            action: z.literal("files"),
            snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
            files: z.array(indexedFileSchema).min(1).max(20),
          })
          .strict(),
        z
          .object({ action: z.literal("complete"), snapshotId: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict(),
      ]),
      await readJsonBody(c),
      "Invalid repository index upload.",
    );
    if (body.action === "begin") {
      if (revision && body.manifest.commit !== revision)
        throw badRequest(
          "INDEX_REVISION_MISMATCH",
          "The uploaded index must match the authorized runner revision.",
        );
      await beginRepositoryIndex(c.env.DB, principal.projectId, body.manifest);
    } else {
      const snapshot = await c.env.DB.prepare(
        "SELECT commit_sha FROM repository_indexes WHERE project_id=? AND snapshot_id=?",
      )
        .bind(principal.projectId, body.snapshotId)
        .first<{ commit_sha: string | null }>();
      if (revision && snapshot?.commit_sha !== revision)
        throw badRequest(
          "INDEX_REVISION_MISMATCH",
          "The index does not belong to this runner revision.",
        );
      if (body.action === "files")
        await uploadRepositoryIndexFiles(
          c.env.DB,
          principal.projectId,
          body.snapshotId,
          body.files,
        );
      else await completeRepositoryIndex(c.env.DB, principal.projectId, body.snapshotId);
    }
    return c.json({
      data: { received: true },
      meta: { requestId: getRequestContext(c).requestId },
    });
  });
  return routes;
}
