import type { Context, MiddlewareHandler } from "hono";

import type { AppConfig } from "../config";
import { getConfig } from "../config";
import { resolveSession } from "../persistence/sessions";
import { resolveUserSession, type DeveloperIdentity } from "../persistence/identity";
import { log, logError } from "../observability/logger";
import { ApiError, badRequest } from "./errors";
import { clearCookie, readAuthSessionToken, AUTH_COOKIE_NAME } from "../lib/cookie";

export interface SandboxSession {
  idHash: string;
  ipHash: string;
  isNew: boolean;
}

export interface RequestContext {
  requestId: string;
  config: AppConfig;
}

export interface AuthenticatedPrincipal {
  user: DeveloperIdentity;
  sessionId: string;
  sessionHash: string;
}

export interface AppVariables {
  requestContext: RequestContext;
  session: SandboxSession;
  auth: AuthenticatedPrincipal | null;
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

export function authSessionMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const secureCookies = new URL(c.req.url).protocol === "https:";
    const token = readAuthSessionToken(c.req.header("cookie") ?? null);
    if (token === null) {
      c.set("auth", null);
      await next();
      return;
    }

    const resolved = await resolveUserSession(c.env.DB, token);
    if (resolved === null) {
      c.set("auth", null);
      c.header("Set-Cookie", clearCookie(AUTH_COOKIE_NAME, secureCookies), { append: true });
      await next();
      return;
    }

    c.set("auth", {
      user: resolved.user,
      sessionId: resolved.sessionId,
      sessionHash: resolved.sessionHash,
    });
    await next();
  };
}

/**
 * Content-Security-Policy.
 *
 * Production allows only same-origin scripts and styles. Inline styles remain
 * permitted because the UI sets style attributes (for example the theme
 * transition), and inline scripts are not.
 *
 * Vite's development server needs inline bootstrap scripts and a WebSocket for
 * HMR, so those allowances are scoped to localhost/127.0.0.1 only. A deployed
 * Worker never sees those hostnames.
 */
function contentSecurityPolicy(origin: URL): string {
  const isLocal =
    origin.hostname === "localhost" ||
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "[::1]";

  const scriptSrc = isLocal ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self'";
  const connectSrc = isLocal ? "'self' ws: wss: http://localhost:* http://127.0.0.1:*" : "'self'";

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
  ].join("; ");
}

export function securityHeadersMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", contentSecurityPolicy(new URL(c.req.url)));
    // The inspector exposes a copy-to-clipboard control, so clipboard-write is
    // granted to the app itself; every other powerful feature is disabled.
    c.header(
      "Permissions-Policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), clipboard-write=(self)",
    );
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
      // A reverse proxy can forward HTTPS to an internal HTTP listener. Trust
      // only the explicit operator-configured origin, never forwarded headers.
      let publicOrigin: string | null = null;
      try {
        const configured = new URL(c.env.PUBLIC_APP_ORIGIN?.trim() ?? "");
        const localHttp =
          configured.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(configured.hostname);
        if (
          (configured.protocol === "https:" || localHttp) &&
          configured.pathname === "/" &&
          !configured.search &&
          !configured.hash &&
          !configured.username &&
          !configured.password
        ) {
          publicOrigin = configured.origin;
        }
      } catch {
        // Missing/invalid deployment configuration cannot widen trusted origins.
      }
      if (origin !== expected && origin !== publicOrigin) {
        throw new ApiError(403, "CROSS_ORIGIN_REJECTED", "Cross-origin writes are not permitted.");
      }
    }
    const site = c.req.header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      throw new ApiError(403, "CROSS_ORIGIN_REJECTED", "Cross-site writes are not permitted.");
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
