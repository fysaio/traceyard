import { Hono } from "hono";

import { getSandboxStatus } from "../../persistence/quotas";
import { getRequestContext, type AppEnv } from "../middleware";

export const sandboxRoutes = new Hono<AppEnv>();

sandboxRoutes.get("/sandbox", async (c) => {
  const { config, requestId } = getRequestContext(c);
  const status = await getSandboxStatus(c.env.DB, config, c.get("session").idHash);
  return c.json({ data: status, meta: { requestId } });
});
