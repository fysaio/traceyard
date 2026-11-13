import { Hono } from "hono";

import { overviewQuerySchema } from "../../../shared/contracts/api";
import { buildAnalytics, buildOverview } from "../../services/analytics-service";
import { parseWith } from "../errors";
import { getRequestContext, type AppEnv } from "../middleware";

export const overviewRoutes = new Hono<AppEnv>();

overviewRoutes.get("/overview", async (c) => {
  const { config, requestId } = getRequestContext(c);
  const query = parseWith(
    overviewQuerySchema,
    Object.fromEntries(new URL(c.req.url).searchParams),
    "The overview query is invalid.",
  );
  const payload = await buildOverview(
    c.env.DB,
    config,
    c.get("session").idHash,
    query.days,
    c.get("auth")?.user.id ?? null,
  );
  return c.json({ data: payload, meta: { requestId } });
});

overviewRoutes.get("/analytics", async (c) => {
  const { config, requestId } = getRequestContext(c);
  const query = parseWith(
    overviewQuerySchema,
    Object.fromEntries(new URL(c.req.url).searchParams),
    "The analytics query is invalid.",
  );
  const payload = await buildAnalytics(
    c.env.DB,
    config,
    c.get("session").idHash,
    query.days,
    c.get("auth")?.user.id ?? null,
  );
  return c.json({ data: payload, meta: { requestId } });
});
