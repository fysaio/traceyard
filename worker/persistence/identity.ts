import { fingerprint, randomId, randomToken, sha256Hex } from "../lib/crypto";
import { isoFromNow, nowIso } from "../lib/time";

const USER_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface DeveloperIdentity {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface UserSessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface CreatedUserSession {
  token: string;
  sessionHash: string;
  sessionId: string;
  expiresAt: string;
}

export interface ResolvedUserSession {
  sessionHash: string;
  sessionId: string;
  user: DeveloperIdentity;
}

interface IdentityRow {
  user_id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
}

interface UserSessionRow extends IdentityRow {
  session_id: string;
  last_seen_at: string;
}

export async function getOrCreateGitHubIdentity(
  db: D1Database,
  profile: GitHubProfile,
): Promise<DeveloperIdentity> {
  const existing = await findGitHubIdentity(db, String(profile.id));
  if (existing !== null) {
    await db.batch([
      db
        .prepare(`UPDATE users SET login = ?, display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?`)
        .bind(profile.login, profile.name, profile.avatarUrl, nowIso(), existing.user_id),
      db
        .prepare(
          `UPDATE identities SET provider_login = ?, updated_at = ?
            WHERE provider = 'github' AND provider_subject = ?`,
        )
        .bind(profile.login, nowIso(), String(profile.id)),
    ]);
    return toDeveloperIdentity(existing.user_id, profile);
  }

  const userId = randomId("usr");
  const now = nowIso();
  const workspaceId = randomId("prj");
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO users (id, login, display_name, avatar_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(userId, profile.login, profile.name, profile.avatarUrl, now, now),
      db
        .prepare(
          `INSERT INTO projects (id, slug, name, kind, created_at, owner_user_id)
           VALUES (?, ?, 'Personal workspace', 'standard', ?, ?)`,
        )
        .bind(workspaceId, `workspace-${userId}`, now, userId),
      db
        .prepare(
          `INSERT INTO identities (
             id, user_id, provider, provider_subject, provider_login, created_at, updated_at
           ) VALUES (?, ?, 'github', ?, ?, ?, ?)`,
        )
        .bind(randomId("idt"), userId, String(profile.id), profile.login, now, now),
    ]);
    return toDeveloperIdentity(userId, profile);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("identities.provider")) {
      throw error;
    }

    const winner = await findGitHubIdentity(db, String(profile.id));
    if (winner === null) throw error;
    await db
      .prepare(`UPDATE users SET login = ?, display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?`)
      .bind(profile.login, profile.name, profile.avatarUrl, nowIso(), winner.user_id)
      .run();
    return toDeveloperIdentity(winner.user_id, profile);
  }
}

export async function createUserSession(
  db: D1Database,
  userId: string,
  request: Request,
): Promise<CreatedUserSession> {
  const token = randomToken(32);
  const sessionHash = await sha256Hex(token);
  const sessionId = randomId("ses");
  const now = nowIso();
  const expiresAt = isoFromNow(USER_SESSION_LIFETIME_MS);
  const ipHash = await fingerprint(request.headers.get("cf-connecting-ip") ?? "local-development");
  const userAgentHash = await fingerprint((request.headers.get("user-agent") ?? "unknown").slice(0, 256));

  await db
    .prepare(
      `INSERT INTO user_sessions (
         id, user_id, session_hash, user_agent_hash, ip_hash,
         created_at, last_seen_at, expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(sessionId, userId, sessionHash, userAgentHash, ipHash, now, now, expiresAt)
    .run();

  return { token, sessionHash, sessionId, expiresAt };
}

export async function resolveUserSession(
  db: D1Database,
  token: string,
): Promise<ResolvedUserSession | null> {
  const sessionHash = await sha256Hex(token);
  const now = nowIso();
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.last_seen_at,
              u.id AS user_id, u.login, u.display_name, u.avatar_url
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.session_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .bind(sessionHash, now)
    .first<UserSessionRow>();
  if (row === null) return null;

  if (Date.parse(now) - Date.parse(row.last_seen_at) > 60 * 60 * 1000) {
    await db
      .prepare(`UPDATE user_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .bind(now, row.session_id)
      .run();
  }

  return {
    sessionHash,
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      login: row.login,
      name: row.display_name,
      avatarUrl: row.avatar_url,
    },
  };
}

export async function listUserSessions(
  db: D1Database,
  userId: string,
  currentSessionId: string,
): Promise<UserSessionInfo[]> {
  const result = await db
    .prepare(
      `SELECT id, created_at, last_seen_at
         FROM user_sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY last_seen_at DESC
        LIMIT 25`,
    )
    .bind(userId, nowIso())
    .all<{ id: string; created_at: string; last_seen_at: string }>();

  return result.results.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    current: row.id === currentSessionId,
  }));
}

export async function revokeUserSession(
  db: D1Database,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE user_sessions SET revoked_at = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .bind(nowIso(), sessionId, userId)
    .run();
  return result.meta.changes === 1;
}

export async function revokeAuthSession(db: D1Database, sessionHash: string): Promise<void> {
  await db
    .prepare(
      `UPDATE user_sessions SET revoked_at = ?
        WHERE session_hash = ? AND revoked_at IS NULL`,
    )
    .bind(nowIso(), sessionHash)
    .run();
}

export async function claimGuestRuns(
  db: D1Database,
  userId: string,
  projectId: string,
  guestSessionHash: string,
  actorIdHash: string,
  requestId: string,
): Promise<number> {
  const now = nowIso();
  const [claimed] = await db.batch([
    db
      .prepare(
        `UPDATE runs
            SET owner_user_id = ?, project_id = ?
          WHERE owner_user_id IS NULL
            AND owner_session_hash = ?
            AND project_id = 'prj_sandbox'
            AND expires_at > ?
          RETURNING id`,
      )
      .bind(userId, projectId, guestSessionHash, now),
    db
      .prepare(
        `INSERT INTO audit_events (
           project_id, actor_type, actor_id_hash, action, target_type, target_id,
           metadata_json, request_id, created_at
         )
         SELECT ?, 'user', ?, 'guest_runs.claimed', 'sandbox_session', NULL,
                json_object('claimedRuns', changes()), ?, ?
          WHERE changes() > 0`,
      )
      .bind(projectId, actorIdHash, requestId, now),
  ]);
  return claimed?.results.length ?? 0;
}

async function findGitHubIdentity(db: D1Database, subject: string): Promise<IdentityRow | null> {
  return db
    .prepare(
      `SELECT u.id AS user_id, u.login, u.display_name, u.avatar_url
         FROM identities i
         JOIN users u ON u.id = i.user_id
        WHERE i.provider = 'github' AND i.provider_subject = ?`,
    )
    .bind(subject)
    .first<IdentityRow>();
}

function toDeveloperIdentity(userId: string, profile: GitHubProfile): DeveloperIdentity {
  return {
    id: userId,
    login: profile.login,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
  };
}
