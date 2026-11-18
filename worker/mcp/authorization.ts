import { z } from "zod";
import { randomId, randomToken, sha256Hex, sha256Base64Url, fingerprint } from "../lib/crypto";
import { nowIso, isoFromNow } from "../lib/time";
import { ApiError, badRequest, forbidden, tooManyRequests } from "../api/errors";
export const AGENT_SCOPES = ["investigations:read", "investigations:run", "runs:recover"] as const;
export interface AgentPrincipal {
  grantId: string;
  userId: string;
  projectId: string;
  clientId: string;
  scopes: string[];
  redirects: string[];
}
export function agentOrigin(env: Env, url: string) {
  const origin = new URL(env.PUBLIC_APP_ORIGIN ?? url);
  if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))
  )
    throw badRequest("ORIGIN_REQUIRED", "Configure the public application origin.");
  return origin.origin;
}
const redirect = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    const u = new URL(value);
    return (
      !u.username &&
      !u.password &&
      !u.hash &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
    );
  }, "Use HTTPS or a loopback callback without fragments.");
export const clientRegistrationSchema = z
  .object({
    client_name: z.string().trim().min(1).max(100).default("Coding agent"),
    redirect_uris: z.array(redirect).min(1).max(5),
    token_endpoint_auth_method: z.literal("none").default("none"),
    grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
    response_types: z.array(z.literal("code")).optional(),
    scope: z.string().max(200).optional(),
  })
  .strip();
export async function registerAgentClient(
  db: D1Database,
  request: Request,
  body: z.infer<typeof clientRegistrationSchema>,
) {
  const ip = await fingerprint(request.headers.get("cf-connecting-ip") ?? "unknown"),
    at = nowIso();
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE ip_hash=? AND created_at>?")
    .bind(ip, isoFromNow(-10 * 60000))
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= 10)
    throw tooManyRequests(
      "REGISTRATION_LIMIT",
      "Too many client registrations. Try again later.",
      600,
    );
  const id = randomId("client");
  const inserted = await db
    .prepare(
      "INSERT INTO oauth_clients(id,name,redirects_json,ip_hash,created_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM oauth_clients WHERE ip_hash=? AND created_at>?)<10 RETURNING id",
    )
    .bind(
      id,
      body.client_name,
      JSON.stringify(body.redirect_uris),
      ip,
      at,
      ip,
      isoFromNow(-10 * 60000),
    )
    .first();
  if (!inserted)
    throw tooManyRequests(
      "REGISTRATION_LIMIT",
      "Too many client registrations. Try again later.",
      600,
    );
  return {
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...body,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scopes: string[];
  resource: string;
}
export async function validateAuthorization(
  db: D1Database,
  origin: string,
  query: Record<string, string>,
): Promise<AuthorizationRequest> {
  const client = await db
    .prepare("SELECT redirects_json FROM oauth_clients WHERE id=?")
    .bind(query.client_id ?? "")
    .first<{ redirects_json: string }>();
  if (
    !client ||
    !(JSON.parse(client.redirects_json) as string[]).includes(query.redirect_uri ?? "")
  )
    throw badRequest("INVALID_CLIENT", "The client or registered callback is invalid.");
  if (
    query.response_type !== "code" ||
    query.code_challenge_method !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge ?? "")
  )
    throw badRequest(
      "INVALID_AUTHORIZATION_REQUEST",
      "Authorization requires code flow with S256 PKCE.",
    );
  const scopes = [
    ...new Set(
      (query.scope ?? "investigations:read investigations:run").split(/\s+/).filter(Boolean),
    ),
  ];
  if (
    !scopes.length ||
    scopes.some((scope) => !AGENT_SCOPES.includes(scope as (typeof AGENT_SCOPES)[number]))
  )
    throw badRequest("INVALID_SCOPE", "The requested agent scope is unsupported.");
  const resource = query.resource ?? origin + "/mcp";
  if (resource !== origin + "/mcp")
    throw badRequest(
      "INVALID_RESOURCE",
      "The access token must target this Traceyard MCP resource.",
    );
  if ((query.state?.length ?? 0) > 2000)
    throw badRequest("INVALID_STATE", "The authorization state is too long.");
  return {
    clientId: query.client_id!,
    redirectUri: query.redirect_uri!,
    challenge: query.code_challenge!,
    state: query.state ?? "",
    scopes,
    resource,
  };
}
export async function createConsent(db: D1Database, userId: string, request: AuthorizationRequest) {
  const token = randomToken();
  await db
    .prepare(
      "INSERT INTO oauth_consents(token_hash,owner_user_id,request_json,expires_at) VALUES(?,?,?,?)",
    )
    .bind(await sha256Hex(token), userId, JSON.stringify(request), isoFromNow(10 * 60000))
    .run();
  return token;
}
export async function approveConsent(
  db: D1Database,
  userId: string,
  token: string,
  projectId: string,
  approved: boolean,
) {
  const project = await db
    .prepare("SELECT id FROM projects WHERE id=? AND owner_user_id=?")
    .bind(projectId, userId)
    .first();
  if (!project) throw forbidden("PROJECT_REQUIRED", "Choose a project you own.");
  const consent = await db
    .prepare(
      "UPDATE oauth_consents SET consumed_at=? WHERE token_hash=? AND owner_user_id=? AND expires_at>? AND consumed_at IS NULL RETURNING request_json",
    )
    .bind(nowIso(), await sha256Hex(token), userId, nowIso())
    .first<{ request_json: string }>();
  if (!consent)
    throw badRequest("CONSENT_EXPIRED", "This authorization request expired or was already used.");
  const request = JSON.parse(consent.request_json) as AuthorizationRequest,
    url = new URL(request.redirectUri);
  if (request.state) url.searchParams.set("state", request.state);
  if (!approved) {
    url.searchParams.set("error", "access_denied");
    return url.toString();
  }
  const code = randomToken(),
    grant = randomId("grant");
  await db.batch([
    db
      .prepare(
        "INSERT INTO mcp_grants(id,owner_user_id,project_id,client_id,scopes_json,resource,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        grant,
        userId,
        projectId,
        request.clientId,
        JSON.stringify(request.scopes),
        request.resource,
        nowIso(),
      ),
    db
      .prepare(
        "INSERT INTO oauth_codes(token_hash,grant_id,challenge,redirect_uri,expires_at) VALUES(?,?,?,?,?)",
      )
      .bind(
        await sha256Hex(code),
        grant,
        request.challenge,
        request.redirectUri,
        isoFromNow(5 * 60000),
      ),
  ]);
  url.searchParams.set("code", code);
  return url.toString();
}
function oauthError() {
  return new ApiError(
    400,
    "invalid_grant",
    "The authorization grant is invalid, expired or already used.",
  );
}
async function issueTokens(db: D1Database, grantId: string) {
  const access = "tym_" + randomToken(),
    refresh = "tyf_" + randomToken();
  await db.batch([
    db
      .prepare("INSERT INTO mcp_access_tokens(token_hash,grant_id,expires_at) VALUES(?,?,?)")
      .bind(await sha256Hex(access), grantId, isoFromNow(3600000)),
    db
      .prepare("INSERT INTO mcp_refresh_tokens(token_hash,grant_id,expires_at) VALUES(?,?,?)")
      .bind(await sha256Hex(refresh), grantId, isoFromNow(30 * 86400000)),
  ]);
  const grant = await db
    .prepare("SELECT scopes_json FROM mcp_grants WHERE id=?")
    .bind(grantId)
    .first<{ scopes_json: string }>();
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refresh,
    scope: (JSON.parse(grant!.scopes_json) as string[]).join(" "),
  };
}
export async function exchangeAgentToken(db: D1Database, origin: string, form: URLSearchParams) {
  const type = form.get("grant_type"),
    clientId = form.get("client_id"),
    resource = form.get("resource") ?? origin + "/mcp";
  if (resource !== origin + "/mcp") throw oauthError();
  if (type === "authorization_code") {
    const verifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw oauthError();
    const hash = await sha256Hex(form.get("code") ?? "");
    const row = await db
      .prepare(
        "SELECT c.grant_id,c.challenge,c.redirect_uri FROM oauth_codes c JOIN mcp_grants g ON g.id=c.grant_id WHERE c.token_hash=? AND c.consumed_at IS NULL AND c.expires_at>? AND g.client_id=? AND g.revoked_at IS NULL AND g.resource=?",
      )
      .bind(hash, nowIso(), clientId, resource)
      .first<{ grant_id: string; challenge: string; redirect_uri: string }>();
    if (
      !row ||
      row.redirect_uri !== form.get("redirect_uri") ||
      row.challenge !== (await sha256Base64Url(verifier))
    )
      throw oauthError();
    const consumed = await db
      .prepare(
        "UPDATE oauth_codes SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL RETURNING grant_id",
      )
      .bind(nowIso(), hash)
      .first();
    if (!consumed) throw oauthError();
    return issueTokens(db, row.grant_id);
  }
  if (type === "refresh_token") {
    const hash = await sha256Hex(form.get("refresh_token") ?? "");
    const row = await db
      .prepare(
        "SELECT t.grant_id,g.scopes_json FROM mcp_refresh_tokens t JOIN mcp_grants g ON g.id=t.grant_id WHERE t.token_hash=? AND t.consumed_at IS NULL AND t.expires_at>? AND g.client_id=? AND g.revoked_at IS NULL AND g.resource=?",
      )
      .bind(hash, nowIso(), clientId, resource)
      .first<{ grant_id: string; scopes_json: string }>();
    if (!row) throw oauthError();
    if (
      form.get("scope") &&
      form
        .get("scope")!
        .split(/\s+/)
        .some((s) => !(JSON.parse(row.scopes_json) as string[]).includes(s))
    )
      throw oauthError();
    const consumed = await db
      .prepare(
        "UPDATE mcp_refresh_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL RETURNING grant_id",
      )
      .bind(nowIso(), hash)
      .first();
    if (!consumed) throw oauthError();
    return issueTokens(db, row.grant_id);
  }
  throw new ApiError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
}
export async function authenticateAgent(
  db: D1Database,
  origin: string,
  request: Request,
): Promise<AgentPrincipal | null> {
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer (tym_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) return null;
  const row = await db
    .prepare(
      "SELECT g.id,g.owner_user_id,g.project_id,g.client_id,g.scopes_json,c.redirects_json FROM mcp_access_tokens t JOIN mcp_grants g ON g.id=t.grant_id JOIN projects p ON p.id=g.project_id AND p.owner_user_id=g.owner_user_id JOIN oauth_clients c ON c.id=g.client_id WHERE t.token_hash=? AND t.expires_at>? AND g.revoked_at IS NULL AND g.resource=?",
    )
    .bind(await sha256Hex(token), nowIso(), origin + "/mcp")
    .first<{
      id: string;
      owner_user_id: string;
      project_id: string;
      client_id: string;
      scopes_json: string;
      redirects_json: string;
    }>();
  if (!row) return null;
  const minute = nowIso().slice(0, 16),
    quota = await db
      .prepare(
        "INSERT INTO mcp_request_limits(grant_id,minute,count) VALUES(?,?,1) ON CONFLICT(grant_id,minute) DO UPDATE SET count=count+1 WHERE count<120 RETURNING count",
      )
      .bind(row.id, minute)
      .first();
  if (!quota)
    throw tooManyRequests(
      "AGENT_RATE_LIMIT",
      "This connection reached its request budget. Inspect again after the current minute.",
      60,
    );
  return {
    grantId: row.id,
    userId: row.owner_user_id,
    projectId: row.project_id,
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json),
    redirects: JSON.parse(row.redirects_json),
  };
}
export function requireAgentScope(principal: AgentPrincipal, scope: string) {
  if (!principal.scopes.includes(scope))
    throw forbidden("AGENT_SCOPE_REQUIRED", "This connection does not grant " + scope + ".");
}
