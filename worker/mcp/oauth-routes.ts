import { Hono } from "hono";
import {
  AGENT_SCOPES,
  agentOrigin,
  clientRegistrationSchema,
  registerAgentClient,
  validateAuthorization,
  createConsent,
  approveConsent,
  exchangeAgentToken,
} from "./authorization";
import { listOwnedProjects } from "../persistence/projects";
import { ownedProject } from "../integrations/access";
import { sha256Hex } from "../lib/crypto";
import { nowIso } from "../lib/time";
import { ApiError, badRequest, parseWith } from "../api/errors";
import { readJsonBody, type AppEnv } from "../api/middleware";
const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Traceyard</title><link rel="stylesheet" href="/agent-connect.css"></head><body><main><a class="brand" href="/">Traceyard.</a><h1>${escape(title)}</h1>${body}</main></body></html>`;
export const authorizationFailurePage = (message: string, requestId: string) =>
  page(
    "Your agent is not connected yet",
    `<p>${escape(message)}</p><p>Return to your coding agent and choose <strong>Authenticate</strong> to start a fresh connection request.</p><p class="muted">Reference: ${escape(requestId)}</p>`,
  );
async function form(c: Parameters<typeof readJsonBody>[0]) {
  if (!c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded"))
    throw badRequest("INVALID_FORM", "Use form-encoded authorization fields.");
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > 16000)
    throw badRequest("INVALID_FORM", "The authorization form is too large.");
  return new URLSearchParams(new TextDecoder().decode(bytes));
}
function tokenFailure(c: Parameters<typeof readJsonBody>[0], error: unknown) {
  return c.json(
    {
      error:
        error instanceof ApiError &&
        ["invalid_grant", "unsupported_grant_type"].includes(error.code)
          ? error.code
          : "invalid_request",
      error_description:
        error instanceof ApiError
          ? error.message
          : "The authorization service could not complete the request.",
    },
    error instanceof ApiError ? error.status : 500,
  );
}
export function oauthRoutes() {
  const app = new Hono<AppEnv>();
  app.use("/oauth/*", async (c, next) => {
    if (c.req.path !== "/oauth/authorize") {
      c.header("Access-Control-Allow-Origin", "*");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      if (c.req.method === "OPTIONS") return c.body(null, 204);
    }
    await next();
  });
  app.get("/.well-known/oauth-protected-resource", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    const origin = agentOrigin(c.env, c.req.url);
    return c.json({
      resource: origin + "/mcp",
      authorization_servers: [origin],
      scopes_supported: AGENT_SCOPES,
      bearer_methods_supported: ["header"],
    });
  });
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    const origin = agentOrigin(c.env, c.req.url);
    return c.json({
      resource: origin + "/mcp",
      authorization_servers: [origin],
      scopes_supported: AGENT_SCOPES,
      bearer_methods_supported: ["header"],
    });
  });
  app.get("/.well-known/oauth-authorization-server", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    const origin = agentOrigin(c.env, c.req.url);
    return c.json({
      issuer: origin,
      authorization_endpoint: origin + "/oauth/authorize",
      token_endpoint: origin + "/oauth/token",
      registration_endpoint: origin + "/oauth/register",
      revocation_endpoint: origin + "/oauth/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: AGENT_SCOPES,
      authorization_response_iss_parameter_supported: true,
    });
  });
  app.post("/oauth/register", async (c) => {
    try {
      const body = parseWith(
        clientRegistrationSchema,
        await readJsonBody(c),
        "Invalid agent registration.",
      );
      return c.json(await registerAgentClient(c.env.DB, c.req.raw, body), 201);
    } catch (error) {
      return tokenFailure(c, error);
    }
  });
  app.get("/oauth/authorize", async (c) => {
    const origin = agentOrigin(c.env, c.req.url),
      request = await validateAuthorization(c.env.DB, origin, c.req.query()),
      auth = c.get("auth");
    if (!auth) {
      const back = new URL(c.req.url).pathname + new URL(c.req.url).search;
      return c.html(
        page(
          "Connect your coding agent",
          `<p>Sign in to choose which repository this agent can investigate.</p><a class="button" href="/api/auth/github/start?returnTo=${encodeURIComponent(back)}">Continue with GitHub</a>`,
        ),
      );
    }
    const projects = await listOwnedProjects(c.env.DB, auth.user.id),
      csrf = await createConsent(c.env.DB, auth.user.id, request);
    const client = await c.env.DB.prepare("SELECT name FROM oauth_clients WHERE id=?")
      .bind(request.clientId)
      .first<{ name: string }>();
    // Chromium also applies form-action to the POST's OAuth redirect. Permit
    // only this validated, registered callback origin on this consent document.
    c.set("oauthFormRedirectOrigin", new URL(request.redirectUri).origin);
    return c.html(
      page(
        "Connect your coding agent",
        `<p><strong>${escape(client?.name ?? "Coding agent")}</strong> wants to connect to one Traceyard project.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="consent" value="${escape(csrf)}"><label for="project">Traceyard project</label><select id="project" name="project" aria-describedby="project-help" required><option value="" disabled selected>Choose a project…</option>${projects.map((p) => `<option value="${escape(p.id)}">${escape(p.repository ?? p.name)}</option>`).join("")}</select><p id="project-help" class="muted">These are your existing Traceyard projects. Choose the codebase you want this agent to debug. Access is limited to your selection.</p><p>For the selected project, this connection can:</p><ul>${request.scopes.map((scope) => `<li>${escape(scope === "investigations:read" ? "Read investigation findings and retained evidence" : scope === "investigations:run" ? "Run supported repository tests and verify candidate repairs" : "Recover supported real workflow executions")}</li>`).join("")}</ul><p class="muted">Revoke this connection from the project’s Connections page at any time. After connecting, finish authentication in your coding agent.</p><div class="actions"><button name="decision" value="approve" ${projects.length ? "" : "disabled"}>Connect agent</button><button class="secondary" name="decision" value="deny" formnovalidate>Cancel</button></div></form>${projects.length ? "" : '<p><a href="/projects">Connect a repository first</a>, then reopen this request.</p>'}`,
      ),
    );
  });
  app.post("/oauth/authorize", async (c) => {
    const auth = c.get("auth");
    if (!auth) throw badRequest("SIGN_IN_REQUIRED", "Sign in before authorizing a coding agent.");
    const body = await form(c),
      destination = await approveConsent(
        c.env.DB,
        auth.user.id,
        body.get("consent") ?? "",
        body.get("project") ?? "",
        body.get("decision") === "approve",
      );
    const url = new URL(destination);
    url.searchParams.set("iss", agentOrigin(c.env, c.req.url));
    return c.redirect(url.toString(), 302);
  });
  app.post("/oauth/token", async (c) => {
    try {
      return c.json(
        await exchangeAgentToken(c.env.DB, agentOrigin(c.env, c.req.url), await form(c)),
      );
    } catch (error) {
      return tokenFailure(c, error);
    }
  });
  app.post("/oauth/revoke", async (c) => {
    const body = await form(c),
      hash = await sha256Hex(body.get("token") ?? ""),
      client = body.get("client_id") ?? "";
    await c.env.DB.prepare(
      "UPDATE mcp_grants SET revoked_at=? WHERE client_id=? AND (id IN (SELECT grant_id FROM mcp_access_tokens WHERE token_hash=?) OR id IN (SELECT grant_id FROM mcp_refresh_tokens WHERE token_hash=?))",
    )
      .bind(nowIso(), client, hash, hash)
      .run();
    return c.json({});
  });
  app.get("/api/projects/:projectId/agent-connections", async (c) => {
    const { projectId } = await ownedProject(c);
    const rows = await c.env.DB.prepare(
      "SELECT g.id,c.name,g.scopes_json,g.created_at,g.revoked_at FROM mcp_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE g.project_id=? ORDER BY g.created_at DESC LIMIT 50",
    )
      .bind(projectId)
      .all();
    return c.json({ data: { items: rows.results } });
  });
  app.post("/api/projects/:projectId/agent-connections/:id/revoke", async (c) => {
    const { projectId } = await ownedProject(c);
    await c.env.DB.prepare("UPDATE mcp_grants SET revoked_at=? WHERE id=? AND project_id=?")
      .bind(nowIso(), c.req.param("id"), projectId)
      .run();
    return c.json({ data: { revoked: true } });
  });
  return app;
}
