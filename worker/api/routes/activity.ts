import { Hono } from "hono";
import { ownedProject } from "../../integrations/access";
import { getRequestContext, type AppEnv } from "../middleware";
interface Row {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  steps?: number;
}
export const activityRoutes = new Hono<AppEnv>();
activityRoutes.get("/projects/:projectId/activity", async (c) => {
  const { projectId } = await ownedProject(c);
  const checkRun = c.req.query("checkRun") ?? null;
  const [external, managed] = await Promise.all([
    c.env.DB.prepare(
      "SELECT trace_id AS id,COALESCE(MIN(CASE WHEN parent_span_id IS NULL THEN name END),MIN(name)) AS name,MIN(started_at) AS startedAt,MAX(ended_at) AS endedAt,COUNT(*) AS steps,COALESCE(MAX(CASE WHEN parent_span_id IS NULL THEN status END),CASE WHEN SUM(status='FAILED')>0 THEN 'FAILED' WHEN SUM(status='RUNNING')>0 THEN 'RUNNING' ELSE 'SUCCEEDED' END) AS status FROM trace_spans WHERE project_id=? AND (? IS NULL OR trace_id IN (SELECT trace_id FROM trace_spans WHERE project_id=? AND json_extract(attributes_json,'$.\"traceyard.run.id\"')=?)) GROUP BY trace_id ORDER BY MIN(started_at) DESC LIMIT 100",
    )
      .bind(projectId, checkRun, projectId, checkRun)
      .all<Row>(),
    checkRun
      ? Promise.resolve({ results: [] as Row[] })
      : c.env.DB.prepare(
          "SELECT r.id,w.name,r.created_at AS startedAt,r.completed_at AS endedAt,r.status FROM runs r JOIN workflows w ON w.id=r.workflow_id WHERE r.project_id=? ORDER BY r.created_at DESC LIMIT 100",
        )
          .bind(projectId)
          .all<Row>(),
  ]);
  const items = [
    ...external.results.map((r) => ({ ...r, source: "application" })),
    ...managed.results.map((r) => ({ ...r, source: "managed" })),
  ]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 100);
  return c.json({ data: { items }, meta: { requestId: getRequestContext(c).requestId } });
});
