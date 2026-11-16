import { fingerprint, randomToken, sha256Hex } from "../lib/crypto";
import { readSessionToken, sessionCookie } from "../lib/cookie";
import { nowIso } from "../lib/time";
import type { SandboxSessionRow } from "./rows";

export interface ResolvedSession {
  idHash: string;
  ipHash: string;
  isNew: boolean;
  cookie: string | null;
}

/**
 * Anonymous sessions are identified by a 256-bit random bearer token stored in
 * an HttpOnly cookie. Only its SHA-256 hash is persisted. The token itself is
 * never written to D1 or to logs.
 *
 * Client IP trust boundary: `cf-connecting-ip` is set by Cloudflare's edge and
 * cannot be spoofed by clients when the Worker is reachable only through
 * Cloudflare. This Worker deliberately ignores `x-forwarded-for` and other
 * caller-supplied headers, because outside that trusted edge they are
 * attacker-controlled. `local-development` is used when the header is absent
 * (wrangler/miniflare), which keeps local evidence separate from real traffic.
 */
export async function resolveSession(
  db: D1Database,
  request: Request,
  secureCookies: boolean,
): Promise<ResolvedSession> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local-development";
  const ipHash = await fingerprint(ip);
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  const userAgentHash = await fingerprint(userAgent.slice(0, 256));
  const existingToken = readSessionToken(request.headers.get("cookie"));
  const now = nowIso();

  if (existingToken !== null) {
    const idHash = await sha256Hex(existingToken);
    const existing = await db
      .prepare(`SELECT * FROM sandbox_sessions WHERE id_hash = ?`)
      .bind(idHash)
      .first<SandboxSessionRow>();
    if (existing !== null) {
      if (Date.parse(now) - Date.parse(existing.last_seen_at) > 60 * 60 * 1000) {
        await db
          .prepare(`UPDATE sandbox_sessions SET last_seen_at = ? WHERE id_hash = ?`)
          .bind(now, idHash)
          .run();
      }
      return { idHash, ipHash: existing.ip_hash, isNew: false, cookie: null };
    }
  }

  const token = randomToken(32);
  const idHash = await sha256Hex(token);
  await db
    .prepare(
      `INSERT INTO sandbox_sessions (id_hash, ip_hash, user_agent_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(idHash, ipHash, userAgentHash, now, now)
    .run();

  return {
    idHash,
    ipHash,
    isNew: true,
    cookie: sessionCookie(token, secureCookies),
  };
}
