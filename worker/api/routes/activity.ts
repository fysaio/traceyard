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
  const external = await c.env.DB.prepare(
    "SELECT trace_id AS id,COALESCE(MIN(CASE WHEN parent_span_id IS NULL THEN name END),MIN(name)) AS name,MIN(started_at) AS startedAt,MAX(ended_at) AS endedAt,COUNT(*) AS steps,COALESCE(MAX(CASE WHEN parent_span_id IS NULL THEN status END),CASE WHEN SUM(status='FAILED')>0 THEN 'FAILED' WHEN SUM(status='RUNNING')>0 THEN 'RUNNING' ELSE 'SUCCEEDED' END) AS status FROM trace_spans WHERE project_id=? AND (? IS NULL OR trace_id IN (SELECT trace_id FROM trace_spans WHERE project_id=? AND json_extract(attributes_json,'$.\"traceyard.run.id\"')=?)) GROUP BY trace_id ORDER BY MIN(started_at) DESC LIMIT 100",
  )
    .bind(projectId, checkRun, projectId, checkRun)
    .all<Row>();
  const items = external.results.map((r) => ({ ...r, source: "application" }));
  return c.json({ data: { items }, meta: { requestId: getRequestContext(c).requestId } });
});
