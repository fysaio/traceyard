import { Hono } from "hono";

import type { HealthPayload } from "../../../shared/contracts/api";
import type { AppEnv } from "../middleware";
import { getRequestContext } from "../middleware";
import { logError } from "../../observability/logger";

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/health", async (c) => {
  const { config, requestId } = getRequestContext(c);
  const startedAt = performance.now();
  let databaseStatus: "ok" | "error" = "ok";
  let latencyMs: number | null = null;

  try {
    await c.env.DB.prepare("SELECT 1 AS ok").first();
    latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
  } catch (error) {
    databaseStatus = "error";
    logError("health.database_failed", error, { requestId });
  }

  const hostname = new URL(c.req.url).hostname;
  const environment = /^(localhost|127\.0\.0\.1|\[::1\])$/u.test(hostname)
    ? "development"
    : "production";
  const payload: HealthPayload = {
    status: databaseStatus === "ok" ? "ok" : "degraded",
    version: config.version,
    environment,
    timestamp: new Date().toISOString(),
    checks: {
      database: { status: databaseStatus, latencyMs },
      queue: { status: "configured" },
      workflow: { status: "configured" },
    },
  };

  return c.json({ data: payload, meta: { requestId } }, databaseStatus === "ok" ? 200 : 503);
});
