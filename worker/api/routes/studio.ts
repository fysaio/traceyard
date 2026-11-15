import { Hono } from "hono";
import { z } from "zod";
import {
  graphDraftSchema,
  graphSchema,
  graphLayers,
  INITIAL_GRAPH,
} from "../../../shared/workflow/graph";
import { randomId, sha256Hex } from "../../lib/crypto";
import { nowIso } from "../../lib/time";
import { getOwnedProject } from "../../persistence/projects";
import type { WorkflowRow } from "../../persistence/rows";
import { badRequest, conflict, notFound, parseWith, unauthorized } from "../errors";
import { getRequestContext, readJsonBody, type AppEnv } from "../middleware";

export const studioRoutes = new Hono<AppEnv>();
async function owned(db: D1Database, userId: string | undefined, projectId: string) {
  if (!userId) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to edit workflows.");
  if (!(await getOwnedProject(db, userId, projectId))) throw notFound("Project not found.");
}
async function workflow(db: D1Database, projectId: string, id: string) {
  const w = await db
    .prepare("SELECT * FROM workflows WHERE id = ? AND project_id = ? AND archived_at IS NULL")
    .bind(id, projectId)
    .first<WorkflowRow>();
  if (!w) throw notFound("Workflow not found.");
  return w;
}
const createSchema = z
  .object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).default("") })
  .strict();
const updateSchema = createSchema.extend({
  revision: z.number().int().positive(),
  graph: graphDraftSchema,
});
const publishSchema = z.object({ revision: z.number().int().positive() }).strict();
type Draft = { graph_json: string; revision: number; updated_at: string };

studioRoutes.get("/projects/:projectId/studio", async (c) => {
  const projectId = c.req.param("projectId");
  await owned(c.env.DB, c.get("auth")?.user.id, projectId);
  const rows = await c.env.DB.prepare(
    "SELECT w.*, d.revision FROM workflows w JOIN workflow_drafts d ON d.workflow_id = w.id WHERE w.project_id = ? AND w.archived_at IS NULL ORDER BY w.updated_at DESC",
  )
    .bind(projectId)
    .all();
  return c.json({
    data: { items: rows.results },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
studioRoutes.post("/projects/:projectId/studio", async (c) => {
  const projectId = c.req.param("projectId");
  await owned(c.env.DB, c.get("auth")?.user.id, projectId);
  const body = parseWith(createSchema, await readJsonBody(c), "Enter a workflow name.");
  const id = randomId("wf"),
    now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO workflows (id,project_id,slug,name,description,current_version,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)",
    ).bind(id, projectId, id, body.name, body.description, now, now),
    c.env.DB.prepare(
      "INSERT INTO workflow_drafts (workflow_id,graph_json,revision,updated_at) VALUES (?,?,1,?)",
    ).bind(id, JSON.stringify(INITIAL_GRAPH), now),
  ]);
  return c.json(
    { data: { id, revision: 1 }, meta: { requestId: getRequestContext(c).requestId } },
    201,
  );
});
studioRoutes.post("/projects/:projectId/studio/import", async (c) => {
  const projectId = c.req.param("projectId");
  await owned(c.env.DB, c.get("auth")?.user.id, projectId);
  const b = parseWith(
    createSchema.extend({ schemaVersion: z.literal(1), graph: graphDraftSchema }),
    await readJsonBody(c),
    "Choose a Traceyard workflow JSON exported from Studio (schemaVersion 1).",
  );
  const json = JSON.stringify(b.graph);
  if (new TextEncoder().encode(json).length > 24000)
    throw badRequest("GRAPH_TOO_LARGE", "Workflows are limited to 24 KB.");
  const id = randomId("wf"),
    now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO workflows (id,project_id,slug,name,description,current_version,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)",
    ).bind(id, projectId, id, b.name, b.description, now, now),
    c.env.DB.prepare(
      "INSERT INTO workflow_drafts (workflow_id,graph_json,revision,updated_at) VALUES (?,?,1,?)",
    ).bind(id, json, now),
  ]);
  return c.json(
    { data: { id, revision: 1 }, meta: { requestId: getRequestContext(c).requestId } },
    201,
  );
});
studioRoutes.get("/projects/:projectId/studio/:id", async (c) => {
  const projectId = c.req.param("projectId"),
    id = c.req.param("id");
  await owned(c.env.DB, c.get("auth")?.user.id, projectId);
  const w = await workflow(c.env.DB, projectId, id);
  const draft = await c.env.DB.prepare("SELECT * FROM workflow_drafts WHERE workflow_id = ?")
    .bind(id)
    .first<Draft>();
  if (!draft) throw notFound("Draft not found.");
  const versions = await c.env.DB.prepare(
    "SELECT version,checksum,created_at FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC",
  )
    .bind(id)
    .all();
  return c.json({
    data: {
      ...w,
      graph: JSON.parse(draft.graph_json) as unknown,
      revision: draft.revision,
      versions: versions.results,
    },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
studioRoutes.put("/projects/:projectId/studio/:id", async (c) => {
  const projectId = c.req.param("projectId"),
    id = c.req.param("id");
  await owned(c.env.DB, c.get("auth")?.user.id, projectId);
  await workflow(c.env.DB, projectId, id);
  const b = parseWith(updateSchema, await readJsonBody(c), "Invalid workflow draft.");
  const json = JSON.stringify(b.graph);
  if (new TextEncoder().encode(json).length > 24000)
    throw badRequest("GRAPH_TOO_LARGE", "Workflows are limited to 24 KB.");
  const now = nowIso();
  const rows = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE workflow_drafts SET graph_json = ?, revision = revision+1, updated_at = ? WHERE workflow_id = ? AND revision = ?",
    ).bind(json, now, id, b.revision),
    c.env.DB.prepare(
      "UPDATE workflows SET name = ?, description = ?, updated_at = ? WHERE id = ? AND changes() = 1",
    ).bind(b.name, b.description, now, id),
  ]);
  if (rows[0]?.meta.changes !== 1)
    throw conflict("DRAFT_CONFLICT", "This draft changed elsewhere. Reload before saving.");
  return c.json({
    data: { revision: b.revision + 1 },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
studioRoutes.post("/projects/:projectId/studio/:id/publish", async (c) => {
  const projectId = c.req.param("projectId"),
    id = c.req.param("id");
  await owned(c.env.DB, c.get("auth")?.user.id, projectId);
  const w = await workflow(c.env.DB, projectId, id),
    b = parseWith(publishSchema, await readJsonBody(c), "Invalid publication request.");
  const draft = await c.env.DB.prepare("SELECT * FROM workflow_drafts WHERE workflow_id = ?")
    .bind(id)
    .first<Draft>();
  if (!draft || draft.revision !== b.revision)
    throw conflict("DRAFT_CONFLICT", "Reload the latest draft before publishing.");
  const graph = parseWith(
    graphSchema,
    JSON.parse(draft.graph_json) as unknown,
    "Fix the workflow connections before publishing.",
  );
  const steps = graphLayers(graph)
    .flat()
    .map((n, i) => ({
      key: n.id,
      name: n.name,
      ordinal: i + 1,
      description: n.type,
      timeoutMs: n.type === "model" ? 120000 : 10000,
      retry: { maxAttempts: 1, baseDelayMs: 0, backoff: "fixed", maxDelayMs: 0 },
    }));
  const version = w.current_version + 1,
    checksum = await sha256Hex(draft.graph_json),
    now = nowIso();
  try {
    const changes = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO workflow_versions (id,workflow_id,version,input_schema_json,steps_json,checksum,created_at,graph_json) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM workflow_drafts WHERE workflow_id = ? AND revision = ?) AND EXISTS (SELECT 1 FROM workflows WHERE id = ? AND current_version = ?)",
      ).bind(
        randomId("wfv"),
        id,
        version,
        "{}",
        JSON.stringify(steps),
        checksum,
        now,
        draft.graph_json,
        id,
        b.revision,
        id,
        w.current_version,
      ),
      c.env.DB.prepare(
        "UPDATE workflows SET current_version = ?,updated_at = ? WHERE id = ? AND current_version = ? AND EXISTS (SELECT 1 FROM workflow_versions WHERE workflow_id = ? AND version = ?)",
      ).bind(version, now, id, w.current_version, id, version),
    ]);
    if (changes[0]?.meta.changes !== 1)
      throw conflict("PUBLISH_CONFLICT", "The workflow changed while publishing. Reload it.");
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint/iu.test(error.message))
      throw conflict("PUBLISH_CONFLICT", "Another version was published. Reload it.");
    throw error;
  }
  return c.json(
    { data: { version, checksum }, meta: { requestId: getRequestContext(c).requestId } },
    201,
  );
});
studioRoutes.delete("/projects/:projectId/studio/:id", async (c) => {
  const projectId = c.req.param("projectId"),
    id = c.req.param("id");
  await owned(c.env.DB, c.get("auth")?.user.id, projectId);
  await workflow(c.env.DB, projectId, id);
  await c.env.DB.prepare("UPDATE workflows SET archived_at = ? WHERE id = ? AND project_id = ?")
    .bind(nowIso(), id, projectId)
    .run();
  return c.json({ data: { archived: true }, meta: { requestId: getRequestContext(c).requestId } });
});
