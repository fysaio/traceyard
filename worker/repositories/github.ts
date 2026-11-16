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
    env.GITHUB_APP_WEBHOOK_SECRET &&
    /^[a-f0-9]{40}$/.test(env.TRACEYARD_RUNNER_REF ?? "")
  );
}
export async function githubRequest<T>(
  env: Env,
  installationId: number,
  path: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<T> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
    throw serviceUnavailable(
      "GITHUB_APP_UNCONFIGURED",
      "Repository connection needs the Traceyard GitHub App configuration.",
    );
  if (!path.startsWith("/") || path.startsWith("//")) throw Error("Invalid GitHub API path.");
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
  const appToken = content + "." + base64UrlEncode(new Uint8Array(signature));
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Traceyard",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const tokenResponse = await fetcher(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { ...headers, Authorization: "Bearer " + appToken },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!tokenResponse.ok)
    throw serviceUnavailable(
      "GITHUB_INSTALLATION_UNAVAILABLE",
      "GitHub installation access could not be verified.",
    );
  const token = (await tokenResponse.json()) as { token: string };
  const response = await fetcher("https://api.github.com" + path, {
    ...init,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      ...init.headers,
      Authorization: "Bearer " + token.token,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw badRequest(
      "GITHUB_REQUEST_FAILED",
      `GitHub returned ${response.status}. Check the installation permissions and repository access.`,
    );
  return (response.status === 204 ? null : await response.json()) as T;
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
