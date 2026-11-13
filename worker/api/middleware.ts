import type { Context, MiddlewareHandler } from "hono";

import type { AppConfig } from "../config";
import { getConfig } from "../config";
import { resolveSession } from "../persistence/sessions";
import { log, logError } from "../observability/logger";
import { ApiError, badRequest } from "./errors";

export interface SandboxSession {
  idHash: string;
  ipHash: string;
  isNew: boolean;
}

export interface RequestContext {
  requestId: string;
  config: AppConfig;
}

export interface AppVariables {
  requestContext: RequestContext;
  session: SandboxSession;
}

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};

export function requestContextMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    const config = getConfig(c.env);
    c.set("requestContext", { requestId, config });
    c.header("X-Request-Id", requestId);

    try {
      await next();
    } catch (error) {
      logError("http.unhandled_error", error, {
        requestId,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
      });
      throw error;
    } finally {
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const path = new URL(c.req.url).pathname;
      const status = c.res?.status ?? 500;
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      log(level, "http.request", {
        requestId,
        method: c.req.method,
        path,
        status,
        durationMs,
      });
    }
  };
}

/**
 * Resolves the anonymous sandbox identity. A new 256-bit bearer token is only
 * issued when the request carries no valid session cookie; the token itself is
 * never persisted or logged, only its SHA-256 hash.
 */
export function sessionMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const secureCookies = new URL(c.req.url).protocol === "https:";
    const resolved = await resolveSession(c.env.DB, c.req.raw, secureCookies);
    c.set("session", {
      idHash: resolved.idHash,
      ipHash: resolved.ipHash,
      isNew: resolved.isNew,
    });
    if (resolved.cookie !== null) {
      c.header("Set-Cookie", resolved.cookie);
    }
    await next();
  };
}

export function securityHeadersMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
  };
}

/**
 * Cookie-authenticated mutations require a same-origin browser context. This is
 * defence in depth on top of SameSite=Lax cookies.
 */
export function sameOriginMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
      await next();
      return;
    }

    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const expected = new URL(c.req.url).origin;
      if (origin !== expected) {
        throw new ApiError(403, "CROSS_ORIGIN_REJECTED", "Cross-origin writes are not permitted.");
      }
    } else {
      const site = c.req.header("sec-fetch-site");
      if (site !== undefined && site !== "same-origin" && site !== "none") {
        throw new ApiError(403, "CROSS_ORIGIN_REJECTED", "Cross-site writes are not permitted.");
      }
    }

    await next();
  };
}

const MAX_BODY_BYTES = 32 * 1024;

export async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw badRequest("UNSUPPORTED_MEDIA_TYPE", "Requests must use application/json.");
  }
  const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw badRequest("PAYLOAD_TOO_LARGE", "Request body exceeds the 32 KB limit.");
  }
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw badRequest("PAYLOAD_TOO_LARGE", "Request body exceeds the 32 KB limit.");
  }
  if (text.trim().length === 0) {
    throw badRequest("EMPTY_BODY", "A JSON request body is required.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest("INVALID_JSON", "Request body is not valid JSON.");
  }
}

export function getRequestContext(c: Context<AppEnv>): RequestContext {
  return c.get("requestContext");
}
