import type { Context } from "hono";
import type { AppEnv } from "../api/middleware";
import { getOwnedProject } from "../persistence/projects";
import { notFound, unauthorized, forbidden, tooManyRequests } from "../api/errors";
import { sha256Hex } from "../lib/crypto";
import { nowIso } from "../lib/time";
export async function ownedProject(c: Context<AppEnv>, projectId = c.req.param("projectId")!) {
  const auth = c.get("auth");
  if (!auth) throw unauthorized("AUTHENTICATION_REQUIRED", "Sign in to continue.");
  if (!(await getOwnedProject(c.env.DB, auth.user.id, projectId)))
    throw notFound("Project not found.");
  return { userId: auth.user.id, projectId };
}
export async function keyPrincipal(c: Context<AppEnv>, scope: string) {
  const token = c.req.header("authorization")?.match(/^Bearer (tyk_[A-Za-z0-9_-]{43})$/u)?.[1];
  if (!token) throw unauthorized("API_KEY_REQUIRED", "A valid Bearer API key is required.");
  const key = await c.env.DB.prepare(
    "SELECT k.id,k.project_id,k.owner_user_id,k.scopes_json FROM api_keys k JOIN projects p ON p.id=k.project_id AND p.owner_user_id=k.owner_user_id WHERE k.token_hash=? AND k.revoked_at IS NULL AND k.expires_at>?",
  )
    .bind(await sha256Hex(token), nowIso())
    .first<{ id: string; project_id: string; owner_user_id: string; scopes_json: string }>();
  if (!key) throw unauthorized("API_KEY_INVALID", "The API key is expired, revoked or invalid.");
  if (!(JSON.parse(key.scopes_json) as string[]).includes(scope))
    throw forbidden("SCOPE_REQUIRED", "The API key does not grant " + scope + ".");
  const minute = nowIso().slice(0, 16);
  const quota = await c.env.DB.prepare(
    "INSERT INTO api_request_limits (key_id,minute,count) VALUES (?,?,1) ON CONFLICT(key_id,minute) DO UPDATE SET count=count+1 WHERE count<120 RETURNING count",
  )
    .bind(key.id, minute)
    .first();
  if (!quota)
    throw tooManyRequests("API_RATE_LIMIT", "This key has reached 120 requests per minute.", 60);
  await c.env.DB.prepare("UPDATE api_keys SET last_used_at=? WHERE id=?")
    .bind(nowIso(), key.id)
    .run();
  return { userId: key.owner_user_id, projectId: key.project_id, keyId: key.id };
}
export async function keySession(c: Context<AppEnv>, key: { keyId: string }) {
  const hash = await sha256Hex("api-key-session:" + key.keyId),
    now = nowIso();
  await c.env.DB.prepare(
    "INSERT INTO sandbox_sessions (id_hash,ip_hash,user_agent_hash,created_at,last_seen_at) VALUES (?,?,?,?,?) ON CONFLICT(id_hash) DO UPDATE SET last_seen_at=excluded.last_seen_at",
  )
    .bind(hash, c.get("session").ipHash, "api-key", now, now)
    .run();
  return { ...c.get("session"), idHash: hash, isNew: false };
}
