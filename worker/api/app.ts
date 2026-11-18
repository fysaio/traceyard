import { workspaceRoutes } from "./routes/workspace";
import { investigationRoutes } from "./routes/investigations";
import { repositoryIndexRoutes } from "./routes/repository-index";
import { investigationExecutionRoutes } from "./routes/investigation-execution";
import { verificationRoutes } from "./routes/verifications";
import { oauthRoutes } from "../mcp/oauth-routes";
import { handleMcp } from "../mcp/server";
import { recordingRoutes } from "./routes/recordings";
import { activityRoutes } from "./routes/activity";
import { createRepositoryRoutes } from "./routes/repositories";
import { httpRoutes } from "./routes/http-connections";
import { automationRoutes } from "./routes/automations";
import { experimentRoutes } from "./routes/experiments";
import { approvalRoutes } from "./routes/approvals";
import { gatewayRoutes } from "./routes/gateway";
import { traceRoutes } from "./routes/traces";
import { developerRoutes } from "./routes/developer";
import { studioRoutes } from "./routes/studio";
import { Hono } from "hono";

import type { ApiFailure } from "../../shared/contracts/api";
import { logError } from "../observability/logger";
import { ApiError } from "./errors";
import {
  getRequestContext,
  authSessionMiddleware,
  requestContextMiddleware,
  sameOriginMiddleware,
  securityHeadersMiddleware,
  sessionMiddleware,
  type AppEnv,
} from "./middleware";
import { createAuthRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { overviewRoutes } from "./routes/overview";
import { projectRoutes } from "./routes/projects";
import { runRoutes } from "./routes/runs";
import { sandboxRoutes } from "./routes/sandbox";
import { workflowRoutes } from "./routes/workflows";

function failure(requestId: string, code: string, message: string, details?: unknown): ApiFailure {
  return { error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

export function createApp(options: { githubFetch?: typeof fetch } = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", requestContextMiddleware());
  app.use("*", securityHeadersMiddleware());
  app.use("/api/*", sameOriginMiddleware());
  app.use("/api/*", sessionMiddleware());
  app.use("/api/*", authSessionMiddleware());
  app.use("/oauth/authorize", sameOriginMiddleware());
  app.use("/oauth/authorize", sessionMiddleware());
  app.use("/oauth/authorize", authSessionMiddleware());
  app.options("/mcp", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    c.header(
      "Access-Control-Allow-Headers",
      "Authorization,Content-Type,Accept,MCP-Protocol-Version,MCP-Session-Id",
    );
    return c.body(null, 204);
  });
  app.all("/mcp", handleMcp);
  app.route("/", oauthRoutes());

  app.route("/api", createAuthRoutes(options.githubFetch));
  app.route("/api", projectRoutes);
  app.route("/api", investigationRoutes);
  app.route("/api", repositoryIndexRoutes(options.githubFetch));
  app.route("/api", investigationExecutionRoutes(options.githubFetch));
  app.route("/api", verificationRoutes(options.githubFetch));
  app.route("/api", recordingRoutes(options.githubFetch));
  app.route("/api", activityRoutes);
  app.route("/api", workspaceRoutes(options.githubFetch));
  app.route("/api", createRepositoryRoutes(options.githubFetch));
  app.route("/api", studioRoutes);
  app.route("/api", httpRoutes);
  app.route("/api", traceRoutes);
  app.route("/api", gatewayRoutes);
  app.route("/api", approvalRoutes);
  app.route("/api", automationRoutes);
  app.route("/api", experimentRoutes);
  app.route("/api", developerRoutes);
  app.route("/api", healthRoutes);
  app.route("/api", workflowRoutes);
  app.route("/api", runRoutes);
  app.route("/api", overviewRoutes);
  app.route("/api", sandboxRoutes);

  app.notFound((c) => {
    let requestId = "unknown";
    try {
      requestId = getRequestContext(c).requestId;
    } catch {
      // Middleware did not run; the request context is unavailable.
    }
    return c.json(
      failure(requestId, "NOT_FOUND", "The requested API endpoint does not exist."),
      404,
    );
  });

  app.onError((error, c) => {
    let requestId = "unknown";
    try {
      requestId = getRequestContext(c).requestId;
    } catch {
      // Middleware did not run; the request context is unavailable.
    }

    if (error instanceof ApiError) {
      for (const [name, value] of Object.entries(error.headers ?? {})) {
        c.header(name, value);
      }
      return c.json(failure(requestId, error.code, error.message, error.details), error.status);
    }

    logError("api.unhandled_error", error, { requestId, path: new URL(c.req.url).pathname });
    return c.json(failure(requestId, "INTERNAL_ERROR", "An unexpected error occurred."), 500);
  });

  return app;
}
