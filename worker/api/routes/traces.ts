import { executionTrace } from "../../integrations/execution-trace";
import type { RunRow } from "../../persistence/rows";
import { Hono } from "hono";
import { z } from "zod";
import { spanBatchSchema, redact, type TraceSpan } from "../../../shared/contracts/traces";
import { ownedProject, keyPrincipal } from "../../integrations/access";
import { randomId, randomToken, sha256Hex } from "../../lib/crypto";
import { nowIso, isoFromNow } from "../../lib/time";
import { parseWith, notFound, conflict } from "../errors";
import { getRequestContext, readJsonBody, type AppEnv } from "../middleware";
export const traceRoutes = new Hono<AppEnv>();
export async function ingestSpans(db: D1Database, projectId: string, spans: TraceSpan[]) {
  const now = nowIso();
  // Prevent existing or batch parents from introducing cycles. Parent spans may arrive later.
  for (const s of spans) {
    let parent = s.parentSpanId;
    const seen = new Set([s.spanId]);
    for (let depth = 0; parent; depth++) {
      if (depth > 100 || seen.has(parent))
        throw conflict("SPAN_CYCLE", "Span parent relationships contain a cycle.");
      seen.add(parent);
      const incoming = spans.find((p) => p.traceId === s.traceId && p.spanId === parent);
      if (incoming) parent = incoming.parentSpanId;
      else {
        const old = await db
          .prepare(
            "SELECT parent_span_id FROM trace_spans WHERE project_id=? AND trace_id=? AND span_id=?",
          )
          .bind(projectId, s.traceId, parent)
          .first<{ parent_span_id: string | null }>();
        parent = old?.parent_span_id ?? null;
      }
    }
  }
  await db.batch(
    spans.map((s) =>
      db
        .prepare(
          `INSERT INTO trace_spans (project_id,trace_id,span_id,parent_span_id,name,kind,status,started_at,ended_at,attributes_json,input_json,output_json,error_json,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,trace_id,span_id) DO UPDATE SET status=excluded.status,ended_at=excluded.ended_at,attributes_json=excluded.attributes_json,output_json=excluded.output_json,error_json=excluded.error_json WHERE trace_spans.status='RUNNING' AND trace_spans.parent_span_id IS excluded.parent_span_id AND trace_spans.started_at=excluded.started_at`,
        )
        .bind(
          projectId,
          s.traceId,
          s.spanId,
          s.parentSpanId,
          String(redact(s.name)),
          s.kind,
          s.status,
          s.startedAt,
          s.endedAt,
          JSON.stringify(redact(s.attributes)),
          s.input === undefined ? null : JSON.stringify(redact(s.input)),
          s.output === undefined ? null : JSON.stringify(redact(s.output)),
          s.error === null ? null : JSON.stringify(redact(s.error)),
          now,
        ),
    ),
  );
}
traceRoutes.post("/projects/:projectId/keys", async (c) => {
  const { projectId, userId } = await ownedProject(c);
  const b = parseWith(
    z
      .object({
        name: z.string().trim().min(1).max(80),
        scopes: z
          .array(z.enum(["traces:write", "runs:read", "runs:write"]))
          .min(1)
          .max(3),
      })
      .strict(),
    await readJsonBody(c),
    "Invalid key configuration.",
  );
  const id = randomId("key"),
    token = "tyk_" + randomToken(),
    expiresAt = isoFromNow(90 * 86400000);
  await c.env.DB.prepare(
    "INSERT INTO api_keys (id,project_id,owner_user_id,token_hash,prefix,name,created_at,scopes_json,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      projectId,
      userId,
      await sha256Hex(token),
      token.slice(0, 12),
      b.name,
      nowIso(),
      JSON.stringify([...new Set(b.scopes)]),
      expiresAt,
    )
    .run();
  return c.json(
    { data: { id, token, expiresAt }, meta: { requestId: getRequestContext(c).requestId } },
    201,
  );
});
traceRoutes.get("/projects/:projectId/keys", async (c) => {
  const { projectId } = await ownedProject(c);
  const rows = await c.env.DB.prepare(
    "SELECT id,prefix,name,created_at,last_used_at,revoked_at,scopes_json,expires_at FROM api_keys WHERE project_id=? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(projectId)
    .all();
  return c.json({
    data: { items: rows.results },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
traceRoutes.post("/projects/:projectId/keys/:id/revoke", async (c) => {
  const { projectId } = await ownedProject(c);
  const r = await c.env.DB.prepare(
    "UPDATE api_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND project_id=?",
  )
    .bind(nowIso(), c.req.param("id"), projectId)
    .run();
  if (!r.meta.changes) throw notFound();
  return c.json({ data: { revoked: true }, meta: { requestId: getRequestContext(c).requestId } });
});
traceRoutes.post("/v1/traces", async (c) => {
  const key = await keyPrincipal(c, "traces:write"),
    b = parseWith(spanBatchSchema, await readJsonBody(c), "Invalid trace spans.");
  await ingestSpans(c.env.DB, key.projectId, b.spans);
  return c.json(
    { data: { accepted: b.spans.length }, meta: { requestId: getRequestContext(c).requestId } },
    202,
  );
});
traceRoutes.get("/projects/:projectId/traces", async (c) => {
  const { projectId } = await ownedProject(c);
  const before = c.req.query("before") ?? "9999";
  const rows = await c.env.DB.prepare(
    `SELECT trace_id,COALESCE(MIN(CASE WHEN parent_span_id IS NULL THEN name END),MIN(name)) AS name,MIN(started_at) AS started_at,MAX(ended_at) AS ended_at,COUNT(*) AS span_count,SUM(status='FAILED') AS failed,SUM(status='RUNNING') AS running FROM trace_spans WHERE project_id=? GROUP BY trace_id HAVING MIN(started_at)<? ORDER BY started_at DESC,trace_id DESC LIMIT 100`,
  )
    .bind(projectId, before)
    .all();
  return c.json({
    data: {
      items: [
        ...rows.results,
        ...(
          await c.env.DB.prepare(
            "SELECT 'execution:'||id AS trace_id,workflow_id AS name,COALESCE(started_at,created_at) AS started_at,completed_at AS ended_at,(SELECT COUNT(*) FROM execution_steps s WHERE s.run_id=runs.id) AS span_count,(status='FAILED') AS failed,(status IN ('QUEUED','RUNNING','CANCELLING')) AS running FROM runs WHERE project_id=? AND created_at<? ORDER BY created_at DESC LIMIT 100",
          )
            .bind(projectId, before)
            .all()
        ).results,
      ]
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
        .slice(0, 100),
    },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
traceRoutes.get("/projects/:projectId/traces/:traceId", async (c) => {
  const { projectId } = await ownedProject(c);
  if (c.req.param("traceId").startsWith("execution:")) {
    const run = await c.env.DB.prepare("SELECT * FROM runs WHERE id=? AND project_id=?")
      .bind(c.req.param("traceId").slice(10), projectId)
      .first<RunRow>();
    if (!run) throw notFound("Execution trace not found.");
    return c.json({
      data: { items: await executionTrace(c.env.DB, run), executionId: run.id },
      meta: { requestId: getRequestContext(c).requestId },
    });
  }
  const rows = await c.env.DB.prepare(
    "SELECT * FROM trace_spans WHERE project_id=? AND trace_id=? ORDER BY started_at,span_id LIMIT 1000",
  )
    .bind(projectId, c.req.param("traceId"))
    .all();
  if (!rows.results.length) throw notFound("Trace not found.");
  return c.json({
    data: { items: rows.results },
    meta: { requestId: getRequestContext(c).requestId },
  });
});
