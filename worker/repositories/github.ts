import { nowIso } from "../lib/time";
import { base64UrlEncode } from "../lib/crypto";
import { badRequest, serviceUnavailable } from "../api/errors";
declare global {
  interface Env {
    GITHUB_APP_ID?: string;
    GITHUB_APP_SLUG?: string;
    GITHUB_APP_PRIVATE_KEY?: string;
    GITHUB_APP_WEBHOOK_SECRET?: string;
    TRACEYARD_RUNNER_REF?: string;
  }
}
export function githubConfigured(env: Env) {
  return !!(
    env.GITHUB_APP_ID &&
    env.GITHUB_APP_SLUG &&
    env.GITHUB_APP_PRIVATE_KEY &&
    env.GITHUB_APP_WEBHOOK_SECRET
  );
}
async function githubAppToken(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
    throw serviceUnavailable(
      "GITHUB_APP_UNCONFIGURED",
      "Repository connection needs the Traceyard GitHub App configuration.",
    );
  const encode = (v: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(v))),
    now = Math.floor(Date.now() / 1000);
  const content =
    encode({ alg: "RS256", typ: "JWT" }) +
    "." +
    encode({ iat: now - 30, exp: now + 540, iss: env.GITHUB_APP_ID });
  const pem = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n")
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s/g, "");
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw serviceUnavailable(
      "GITHUB_APP_KEY_INVALID",
      "The GitHub App needs a PKCS#8 RSA private key.",
    );
  }
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(content),
  );
  return content + "." + base64UrlEncode(new Uint8Array(signature));
}
export async function installationAccessToken(
  env: Env,
  installationId: number,
  fetcher: typeof fetch = fetch,
  repositoryId?: number,
  permissions: Record<string, string> = { contents: "read" },
): Promise<string> {
  const appToken = await githubAppToken(env);
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Traceyard",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const tokenResponse = await fetcher(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Authorization: "Bearer " + appToken,
      },
      ...(repositoryId
        ? {
            body: JSON.stringify({
              repository_ids: [repositoryId],
              permissions,
            }),
          }
        : {}),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!tokenResponse.ok)
    throw serviceUnavailable(
      "GITHUB_INSTALLATION_UNAVAILABLE",
      "GitHub installation access could not be verified.",
    );
  const token = (await tokenResponse.json()) as { token: string };
  return token.token;
}
export async function githubRequest<T>(
  env: Env,
  installationId: number,
  path: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) throw Error("Invalid GitHub API path.");
  const token = await installationAccessToken(env, installationId, fetcher);
  return requestWithToken<T>(token, path, init, fetcher);
}
async function requestWithToken<T>(
  token: string,
  path: string,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) throw Error("Invalid GitHub API path.");
  const response = await fetcher("https://api.github.com" + path, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Traceyard",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init.headers,
      Authorization: "Bearer " + token,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw badRequest(
      "GITHUB_REQUEST_FAILED",
      `GitHub returned ${response.status}. Check the installation permissions and repository access.`,
      { githubStatus: response.status },
    );
  const body = await response.text();
  return (body.trim() ? JSON.parse(body) : null) as T;
}
export async function githubJobLog(token: string, path: string, fetcher: typeof fetch) {
  const response = await fetcher("https://api.github.com" + path, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Traceyard",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: "Bearer " + token,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) return null;
  const url = new URL(location);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      /^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
      url.hostname === "results-receiver.actions.githubusercontent.com"
    )
  )
    return null;
  const log = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!log.ok || !log.body) return null;
  const reader = log.body.getReader();
  const decoder = new TextDecoder();
  let contents = "",
    bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return contents + decoder.decode();
      bytes += chunk.value.length;
      if (bytes > 512_000) return null;
      contents += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export async function repositoryGitHubClient(
  env: Env,
  installationId: number,
  repositoryId: number,
  fetcher: typeof fetch = fetch,
) {
  const token = await installationAccessToken(env, installationId, fetcher, repositoryId, {
    contents: "write",
    pull_requests: "write",
    workflows: "write",
    actions: "write",
  });
  return <T>(path: string, init: RequestInit = {}) =>
    requestWithToken<T>(token, path, init, fetcher);
}
export async function repositoryActionsReader(
  env: Env,
  installationId: number,
  repositoryId: number,
  fetcher: typeof fetch,
) {
  const token = await installationAccessToken(env, installationId, fetcher, repositoryId, {
    actions: "read",
    contents: "read",
  });
  return {
    get: <T>(path: string) => requestWithToken<T>(token, path, {}, fetcher),
    log: (path: string) => githubJobLog(token, path, fetcher),
  };
}
export async function syncPersonalInstallation(
  env: Env,
  userId: string,
  fetcher: typeof fetch = fetch,
) {
  const identity = await env.DB.prepare(
    "SELECT provider_subject,provider_login FROM identities WHERE user_id=? AND provider='github'",
  )
    .bind(userId)
    .first<{ provider_subject: string; provider_login: string }>();
  if (!identity) return null;
  const response = await fetcher(
    `https://api.github.com/users/${encodeURIComponent(identity.provider_login)}/installation`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Traceyard",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: "Bearer " + (await githubAppToken(env)),
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (response.status === 404) {
    await env.DB.prepare(
      "UPDATE github_installations SET suspended=1,updated_at=? WHERE account_id=?",
    )
      .bind(nowIso(), identity.provider_subject)
      .run();
    return null;
  }
  if (!response.ok)
    throw serviceUnavailable(
      "GITHUB_INSTALLATION_SYNC_FAILED",
      "GitHub access could not be refreshed. Try again; you do not need to reinstall Traceyard.",
    );
  const installation = (await response.json()) as {
    id: number;
    app_id: number;
    account?: { id: number; login: string; type: string };
    suspended_at?: string | null;
  };
  // A renamed/reused GitHub login must never attach another account's installation.
  if (
    !Number.isSafeInteger(installation.id) ||
    installation.id <= 0 ||
    String(installation.app_id) !== env.GITHUB_APP_ID ||
    installation.account?.type !== "User" ||
    !Number.isSafeInteger(installation.account.id) ||
    String(installation.account.id) !== identity.provider_subject ||
    typeof installation.account.login !== "string" ||
    !/^[A-Za-z0-9-]{1,39}$/.test(installation.account.login)
  )
    throw serviceUnavailable(
      "GITHUB_INSTALLATION_IDENTITY_MISMATCH",
      "GitHub installation ownership could not be verified. Refresh your GitHub sign-in, then retry.",
    );
  const suspended = installation.suspended_at ? 1 : 0;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE github_installations SET suspended=1,updated_at=? WHERE account_id=? AND id<>?",
    ).bind(now, identity.provider_subject, installation.id),
    env.DB.prepare(
      "INSERT INTO github_installations(id,account_id,account_login,suspended,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_login=excluded.account_login,suspended=excluded.suspended,updated_at=excluded.updated_at WHERE github_installations.account_id=excluded.account_id",
    ).bind(installation.id, identity.provider_subject, installation.account.login, suspended, now),
  ]);
  return { id: installation.id, suspended };
}
export async function installationOwned(db: D1Database, userId: string, id: number) {
  // Initial support is deliberately personal installations. Org/team delegation needs a membership model.
  return !!(await db
    .prepare(
      "SELECT g.id FROM github_installations g JOIN identities i ON i.provider='github' AND i.provider_subject=g.account_id WHERE i.user_id=? AND g.id=? AND g.suspended=0",
    )
    .bind(userId, id)
    .first());
}
export async function verifyWebhook(env: Env, body: string, signature: string) {
  if (!env.GITHUB_APP_WEBHOOK_SECRET || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.GITHUB_APP_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signature.slice(7).match(/../g)!, (b) => parseInt(b, 16)),
    new TextEncoder().encode(body),
  );
}
