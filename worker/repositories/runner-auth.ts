import type { Context } from "hono";
import type { AppEnv } from "../api/middleware";
import { keyPrincipal } from "../integrations/access";
import { unauthorized } from "../api/errors";
export function decodePart(value: string) {
  const base = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base.padEnd(Math.ceil(base.length / 4) * 4, "=")), (c) =>
    c.charCodeAt(0),
  );
}
export async function runnerPrincipal(c: Context<AppEnv>, fetcher: typeof fetch = fetch) {
  const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  if (token.startsWith("tyk_"))
    return {
      ...(await keyPrincipal(c, "traces:write")),
      source: "local" as const,
      runId: null,
      sha: null,
    };
  const invalid = () =>
    unauthorized("RUNNER_IDENTITY_INVALID", "The runner identity could not be verified.");
  if (token.length > 16000) throw invalid();
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw invalid();
    const header = JSON.parse(new TextDecoder().decode(decodePart(parts[0]!))) as {
      alg: string;
      kid: string;
    };
    const claims = JSON.parse(new TextDecoder().decode(decodePart(parts[1]!))) as Record<
      string,
      unknown
    >;
    const now = Date.now() / 1000,
      origin = new URL(c.env.PUBLIC_APP_ORIGIN ?? c.req.url).origin;
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      claims.iss !== "https://token.actions.githubusercontent.com" ||
      claims.aud !== origin ||
      typeof claims.exp !== "number" ||
      claims.exp <= now ||
      typeof claims.nbf !== "number" ||
      claims.nbf > now + 30 ||
      claims.runner_environment !== "github-hosted" ||
      !["push", "workflow_dispatch"].includes(String(claims.event_name))
    )
      throw invalid();
    const response = await fetcher("https://token.actions.githubusercontent.com/.well-known/jwks", {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw invalid();
    const jwks = (await response.json()) as { keys: (JsonWebKey & { kid: string })[] };
    const jwk = jwks.keys.find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) throw invalid();
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        decodePart(parts[2]!),
        new TextEncoder().encode(parts[0] + "." + parts[1]),
      ))
    )
      throw invalid();
    const repository = await c.env.DB.prepare(
      "SELECT r.*,g.account_id FROM project_repositories r JOIN github_installations g ON g.id=r.installation_id WHERE r.repository_id=? AND g.suspended=0",
    )
      .bind(Number(claims.repository_id))
      .first<{
        project_id: string;
        full_name: string;
        default_branch: string;
        account_id: string;
      }>();
    if (
      !repository ||
      claims.repository_owner_id !== repository.account_id ||
      claims.ref !== "refs/heads/" + repository.default_branch ||
      String(claims.workflow_ref).toLowerCase() !==
        (
          repository.full_name +
          "/.github/workflows/traceyard.yml@refs/heads/" +
          repository.default_branch
        ).toLowerCase() ||
      !/^[a-f0-9]{40}$/.test(String(claims.sha)) ||
      !/^\d+$/.test(String(claims.run_id)) ||
      !/^\d+$/.test(String(claims.run_attempt))
    )
      throw invalid();
    return {
      projectId: repository.project_id,
      source: "github" as const,
      runId: claims.run_id + "-" + claims.run_attempt,
      sha: String(claims.sha),
    };
  } catch {
    throw invalid();
  }
}
