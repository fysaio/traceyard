import { Hono, type Context } from "hono";
import { z } from "zod";

import {
  AUTH_COOKIE_NAME,
  authSessionCookie,
  clearCookie,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_VERIFIER_COOKIE_NAME,
  oauthCookie,
  readOAuthState,
  readOAuthVerifier,
} from "../../lib/cookie";
import { randomToken, sha256Base64Url, sha256Hex } from "../../lib/crypto";
import { isoFromNow, nowIso } from "../../lib/time";
import {
  claimGuestRuns,
  createUserSession,
  getOrCreateGitHubIdentity,
  listUserSessions,
  revokeAuthSession,
  revokeUserSession,
} from "../../persistence/identity";
import { getDefaultProjectId, getOwnedProject } from "../../persistence/projects";
import { logError } from "../../observability/logger";
import {
  ApiError,
  badRequest,
  forbidden,
  serviceUnavailable,
  unauthorized,
  parseWith,
  notFound,
} from "../errors";
import {
  getRequestContext,
  readJsonBody,
  type AppEnv,
  type AuthenticatedPrincipal,
} from "../middleware";

const PROFILE_SCHEMA = z
  .object({
    id: z.number().int().positive(),
    login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/u),
    name: z.string().max(200).nullable().optional(),
    avatar_url: z
      .string()
      .url()
      .refine((value) => {
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const TOKEN_SCHEMA = z
  .object({
    access_token: z.string().min(1).max(4096),
    token_type: z.string().min(1),
  })
  .passthrough();

interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  origin: string;
  secure: boolean;
}

export function createAuthRoutes(fetcher: typeof fetch = fetch): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/auth/session", async (c) => {
    const auth = c.get("auth");
    const sessions =
      auth === null ? [] : await listUserSessions(c.env.DB, auth.user.id, auth.sessionId);
    return c.json({
      data: {
        user: auth?.user ?? null,
        currentSessionId: auth?.sessionId ?? null,
        sessions,
        githubSignInAvailable: githubOAuthConfigured(c.env),
      },
      meta: { requestId: getRequestContext(c).requestId },
    });
  });

  routes.get("/auth/github/start", async (c) => {
    const config = getGitHubOAuthConfig(c.env);
    const state = randomToken(32);
    const verifier = randomToken(32);
    const stateHash = await sha256Hex(state);
    const now = nowIso();
    await c.env.DB.prepare(
      `INSERT INTO github_oauth_states (state_hash, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, NULL)`,
    )
      .bind(stateHash, now, isoFromNow(10 * 60 * 1000))
      .run();

    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", config.clientId);
    authorize.searchParams.set("redirect_uri", config.callbackUrl);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", await sha256Base64Url(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");

    c.header("Set-Cookie", oauthCookie(OAUTH_STATE_COOKIE_NAME, state, config.secure), {
      append: true,
    });
    c.header("Set-Cookie", oauthCookie(OAUTH_VERIFIER_COOKIE_NAME, verifier, config.secure), {
      append: true,
    });
    return c.redirect(authorize.toString(), 302);
  });

  routes.get("/auth/github/callback", async (c) => {
    const requestId = getRequestContext(c).requestId;
    const secure = new URL(c.req.url).protocol === "https:";
    const cookieHeader = c.req.header("cookie") ?? null;
    const stateCookie = readOAuthState(cookieHeader);
    const verifier = readOAuthVerifier(cookieHeader);
    const query = new URL(c.req.url).searchParams;
    const state = query.get("state");
    const code = query.get("code");

    clearOAuthCookies(c, secure);
    if (query.has("error")) {
      throw badRequest("GITHUB_SIGN_IN_CANCELLED", "GitHub sign-in was cancelled.");
    }
    if (
      state === null ||
      stateCookie === null ||
      verifier === null ||
      !constantTimeEqual(state, stateCookie) ||
      code === null ||
      code.length < 1 ||
      code.length > 512
    ) {
      throw badRequest(
        "INVALID_OAUTH_CALLBACK",
        "The GitHub sign-in response could not be verified.",
      );
    }

    const config = getGitHubOAuthConfig(c.env);
    const consumed = await c.env.DB.prepare(
      `UPDATE github_oauth_states SET consumed_at = ?
        WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?
        RETURNING state_hash`,
    )
      .bind(nowIso(), await sha256Hex(state), nowIso())
      .first<{ state_hash: string }>();
    if (consumed === null) {
      throw badRequest(
        "INVALID_OAUTH_CALLBACK",
        "The GitHub sign-in state is expired or has already been used.",
      );
    }

    let tokenResponse: Response;
    try {
      tokenResponse = await fetcher("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Traceyard",
        },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.callbackUrl,
          code_verifier: verifier,
        }),
      });
    } catch (error) {
      logError("github.oauth_token_exchange_failed", error, { requestId });
      throw serviceUnavailable(
        "GITHUB_PROVIDER_UNAVAILABLE",
        "GitHub sign-in is temporarily unavailable. Please try again.",
        30,
      );
    }
    if (tokenResponse.status === 429 || tokenResponse.status >= 500) {
      throw serviceUnavailable(
        "GITHUB_PROVIDER_UNAVAILABLE",
        "GitHub sign-in is temporarily unavailable. Please try again.",
        readRetryAfter(tokenResponse) ?? 30,
      );
    }
    if (!tokenResponse.ok) {
      throw badRequest("INVALID_OAUTH_CALLBACK", "GitHub did not accept the sign-in code.");
    }

    const tokenPayload = TOKEN_SCHEMA.safeParse(await readResponseJson(tokenResponse));
    if (!tokenPayload.success || tokenPayload.data.token_type.toLowerCase() !== "bearer") {
      throw serviceUnavailable(
        "GITHUB_PROVIDER_RESPONSE_INVALID",
        "GitHub returned an invalid sign-in response. Please try again.",
        30,
      );
    }

    let profileResponse: Response;
    try {
      profileResponse = await fetcher("https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${tokenPayload.data.access_token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Traceyard",
        },
      });
    } catch (error) {
      logError("github.oauth_profile_fetch_failed", error, { requestId });
      throw serviceUnavailable(
        "GITHUB_PROVIDER_UNAVAILABLE",
        "GitHub sign-in is temporarily unavailable. Please try again.",
        30,
      );
    }
    if (profileResponse.status === 429 || profileResponse.status >= 500) {
      throw serviceUnavailable(
        "GITHUB_PROVIDER_UNAVAILABLE",
        "GitHub sign-in is temporarily unavailable. Please try again.",
        readRetryAfter(profileResponse) ?? 30,
      );
    }
    if (!profileResponse.ok) {
      throw badRequest(
        "GITHUB_PROFILE_UNAVAILABLE",
        "GitHub could not verify the sign-in identity.",
      );
    }

    const parsedProfile = PROFILE_SCHEMA.safeParse(await readResponseJson(profileResponse));
    if (!parsedProfile.success) {
      throw serviceUnavailable(
        "GITHUB_PROVIDER_RESPONSE_INVALID",
        "GitHub returned an invalid account profile. Please try again.",
        30,
      );
    }

    const profile = {
      id: parsedProfile.data.id,
      login: parsedProfile.data.login,
      name: parsedProfile.data.name ?? null,
      avatarUrl: parsedProfile.data.avatar_url ?? null,
    };
    const user = await getOrCreateGitHubIdentity(c.env.DB, profile);
    const session = await createUserSession(c.env.DB, user.id, c.req.raw);
    c.header(
      "Set-Cookie",
      authSessionCookie(
        session.token,
        config.secure,
        Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000),
      ),
      { append: true },
    );
    return c.redirect(`${config.origin}/`, 302);
  });

  routes.post("/auth/logout", async (c) => {
    const auth = c.get("auth");
    const secure = new URL(c.req.url).protocol === "https:";
    if (auth !== null) await revokeAuthSession(c.env.DB, auth.sessionHash);
    c.header("Set-Cookie", clearCookie(AUTH_COOKIE_NAME, secure), { append: true });
    return c.json({ data: { ok: true }, meta: { requestId: getRequestContext(c).requestId } });
  });

  routes.get("/auth/guest-work", async (c) => {
    requireAuth(c.get("auth"));
    const row = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM runs WHERE owner_user_id IS NULL AND owner_session_hash=? AND project_id='prj_sandbox' AND expires_at>?",
    )
      .bind(c.get("session").idHash, nowIso())
      .first<{ count: number }>();
    return c.json({
      data: { executions: row?.count ?? 0 },
      meta: { requestId: getRequestContext(c).requestId },
    });
  });
  routes.post("/auth/claim", async (c) => {
    const auth = requireAuth(c.get("auth"));
    const guestSession = c.get("session");
    if (guestSession.isNew) {
      throw forbidden(
        "GUEST_SESSION_REQUIRED",
        "Open Traceyard in the browser that owns the guest work before claiming it.",
      );
    }

    const body = c.req.header("content-type")?.includes("application/json")
      ? parseWith(
          z.object({ projectId: z.string().min(1).max(80) }).strict(),
          await readJsonBody(c),
          "Choose a project for your sandbox work.",
        )
      : null;
    if (body && !(await getOwnedProject(c.env.DB, auth.user.id, body.projectId)))
      throw notFound("Project not found.");
    const projectId = body?.projectId ?? (await getDefaultProjectId(c.env.DB, auth.user.id));
    if (projectId === null) {
      throw new Error("The authenticated account has no personal workspace.");
    }
    const claimed = await claimGuestRuns(
      c.env.DB,
      auth.user.id,
      projectId,
      guestSession.idHash,
      await sha256Hex(auth.user.id),
      getRequestContext(c).requestId,
    );
    return c.json({
      data: { claimedRuns: claimed },
      meta: { requestId: getRequestContext(c).requestId },
    });
  });

  routes.post("/auth/sessions/:id/revoke", async (c) => {
    const auth = requireAuth(c.get("auth"));
    const sessionId = c.req.param("id");
    const revoked = await revokeUserSession(c.env.DB, auth.user.id, sessionId);
    if (!revoked) {
      throw forbidden("SESSION_NOT_ACCESSIBLE", "That session is not available to this account.");
    }
    if (sessionId === auth.sessionId) {
      c.header(
        "Set-Cookie",
        clearCookie("ty_auth_session", new URL(c.req.url).protocol === "https:"),
        { append: true },
      );
    }
    return c.json({ data: { revoked: true }, meta: { requestId: getRequestContext(c).requestId } });
  });

  return routes;
}

function getGitHubOAuthConfig(env: Env): GitHubOAuthConfig {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const configuredOrigin = env.PUBLIC_APP_ORIGIN?.trim();
  if (!clientId || !clientSecret || !configuredOrigin) {
    throw serviceUnavailable(
      "GITHUB_SIGN_IN_UNCONFIGURED",
      "GitHub sign-in is not configured for this deployment.",
    );
  }

  let origin: URL;
  try {
    origin = new URL(configuredOrigin);
  } catch {
    throw serviceUnavailable(
      "GITHUB_SIGN_IN_UNCONFIGURED",
      "GitHub sign-in is not configured for this deployment.",
    );
  }
  const localHttp =
    origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
  if (
    (!localHttp && origin.protocol !== "https:") ||
    origin.pathname !== "/" ||
    origin.search.length > 0 ||
    origin.hash.length > 0 ||
    origin.username.length > 0 ||
    origin.password.length > 0
  ) {
    throw serviceUnavailable(
      "GITHUB_SIGN_IN_UNCONFIGURED",
      "GitHub sign-in is not configured for this deployment.",
    );
  }

  const appOrigin = origin.origin;
  return {
    clientId,
    clientSecret,
    origin: appOrigin,
    callbackUrl: `${appOrigin}/api/auth/github/callback`,
    secure: origin.protocol === "https:",
  };
}

function githubOAuthConfigured(env: Env): boolean {
  try {
    getGitHubOAuthConfig(env);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === "GITHUB_SIGN_IN_UNCONFIGURED") return false;
    throw error;
  }
}

function requireAuth(auth: AuthenticatedPrincipal | null): AuthenticatedPrincipal {
  if (auth === null) {
    throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in with GitHub to continue.");
  }
  return auth;
}

function clearOAuthCookies(c: Context<AppEnv>, secure: boolean): void {
  c.header("Set-Cookie", clearCookie(OAUTH_STATE_COOKIE_NAME, secure), { append: true });
  c.header("Set-Cookie", clearCookie(OAUTH_VERIFIER_COOKIE_NAME, secure), { append: true });
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function readRetryAfter(response: Response): number | null {
  const value = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 3600) : null;
}
