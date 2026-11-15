import { Hono } from "hono";
import { z } from "zod";
import {
  experimentSchema as schema,
  experimentVerdict,
  type ExperimentResult,
} from "../../../shared/contracts/experiments";
import { ownedProject } from "../../integrations/access";
import { randomId, sha256Hex } from "../../lib/crypto";
import { nowIso } from "../../lib/time";
import { getConfig } from "../../config";
import { launchRun } from "../../services/run-service";
import { findWorkflowByIdOrSlug, SANDBOX_PROJECT_ID } from "../../persistence/catalog";
import { assertCatalogMatchesRuntime } from "../../workflows/registry";
import { readJsonBody, getRequestContext, type AppEnv } from "../middleware";
import { parseWith, notFound, badRequest } from "../errors";
type Experiment = { id: string; name: string; config_json: string; created_at: string };

export const experimentRoutes = new Hono<AppEnv>();
experimentRoutes.get("/projects/:projectId/experiments", async (c) => {
  const { projectId } = await ownedProject(c),
    items = await c.env.DB.prepare(
      "SELECT * FROM experiments WHERE project_id=? ORDER BY created_at DESC LIMIT 100",
    )
      .bind(projectId)
      .all<Experiment>();
  const data = [];
  for (const e of items.results) {
    const config = schema.parse(JSON.parse(e.config_json)),
      runs = await c.env.DB.prepare(
        "SELECT r.id,er.ordinal,r.status,r.output_json,CAST(ROUND((julianday(r.completed_at)-julianday(r.started_at))*86400000) AS INTEGER) AS duration_ms,r.workflow_version FROM experiment_runs er JOIN runs r ON r.id=er.run_id WHERE er.experiment_id=? ORDER BY er.ordinal",
      )
        .bind(e.id)
        .all<ExperimentResult>();
    data.push({
      id: e.id,
      name: e.name,
      createdAt: e.created_at,
      config,
      runs: runs.results.map((r) => ({ ...r, verdict: experimentVerdict(config, r) })),
    });
  }
  return c.json({ data: { items: data }, meta: { requestId: getRequestContext(c).requestId } });
});
experimentRoutes.post("/projects/:projectId/experiments", async (c) => {
  const { projectId } = await ownedProject(c),
    body = parseWith(
      z.object({ name: z.string().trim().min(1).max(100), config: schema }).strict(),
      await readJsonBody(c),
      "Invalid experiment.",
    );
  const entry =
    (await findWorkflowByIdOrSlug(
      c.env.DB,
      body.config.workflowId,
      projectId,
      body.config.version,
    )) ??
    (await findWorkflowByIdOrSlug(
      c.env.DB,
      body.config.workflowId,
      SANDBOX_PROJECT_ID,
      body.config.version,
    ));
  if (!entry) throw notFound("Published workflow version not found.");
  if (entry.version.graph_json && body.config.scenario !== "success")
    throw badRequest(
      "UNSUPPORTED_FAULT",
      "Document fault scenarios apply only to the document pipeline.",
    );
  assertCatalogMatchesRuntime(entry).validateInput(body.config.input);
  const id = randomId("exp");
  await c.env.DB.prepare(
    "INSERT INTO experiments (id,project_id,name,config_json,created_at) VALUES (?,?,?,?,?)",
  )
    .bind(
      id,
      projectId,
      body.name,
      JSON.stringify({ ...body.config, workflowId: entry.workflow.id }),
      nowIso(),
    )
    .run();
  return c.json({ data: { id }, meta: { requestId: getRequestContext(c).requestId } }, 201);
});
experimentRoutes.post("/projects/:projectId/experiments/:id/launch", async (c) => {
  const { projectId, userId } = await ownedProject(c),
    id = c.req.param("id"),
    e = await c.env.DB.prepare("SELECT * FROM experiments WHERE id=? AND project_id=?")
      .bind(id, projectId)
      .first<Experiment>();
  if (!e) throw notFound();
  const config = schema.parse(JSON.parse(e.config_json)),
    hash = await sha256Hex("experiment:" + id),
    now = nowIso();
  await c.env.DB.prepare(
    "INSERT INTO sandbox_sessions (id_hash,ip_hash,user_agent_hash,created_at,last_seen_at) VALUES (?,?,?,?,?) ON CONFLICT(id_hash) DO UPDATE SET last_seen_at=excluded.last_seen_at",
  )
    .bind(hash, "experiment", "laboratory", now, now)
    .run();
  const ids = [];
  for (let i = 1; i <= config.repetitions; i++) {
    const existing = await c.env.DB.prepare(
      "SELECT run_id FROM experiment_runs WHERE experiment_id=? AND ordinal=?",
    )
      .bind(id, i)
      .first<{ run_id: string }>();
    if (existing) {
      ids.push(existing.run_id);
      continue;
    }
    const r = await launchRun(c.env, {
      session: { idHash: hash, ipHash: "experiment:" + userId, isNew: false },
      userId,
      requestId: getRequestContext(c).requestId,
      body: {
        workflowId: config.workflowId,
        projectId,
        version: config.version,
        input: config.input,
        scenario: config.scenario,
      },
      idempotencyKey: id + ":" + i,
      config: getConfig(c.env),
    });
    await c.env.DB.prepare(
      "INSERT INTO experiment_runs (experiment_id,run_id,ordinal) VALUES (?,?,?) ON CONFLICT(experiment_id,ordinal) DO NOTHING",
    )
      .bind(id, r.result.run.id, i)
      .run();
    ids.push(r.result.run.id);
  }
  return c.json(
    { data: { runIds: ids }, meta: { requestId: getRequestContext(c).requestId } },
    202,
  );
});
