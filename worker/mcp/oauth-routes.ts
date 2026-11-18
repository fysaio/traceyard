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
    if (!["/oauth/authorize", "/oauth/connections"].includes(c.req.path)) {
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
          `<p>Sign in to connect. You can choose a project later.</p><a class="button" href="/api/auth/github/start?returnTo=${encodeURIComponent(back)}">Continue with GitHub</a>`,
        ),
      );
    }
    const csrf = await createConsent(c.env.DB, auth.user.id, request);
    const client = await c.env.DB.prepare("SELECT name FROM oauth_clients WHERE id=?")
      .bind(request.clientId)
      .first<{ name: string }>();
    // Chromium also applies form-action to the POST's OAuth redirect. Permit
    // only this validated, registered callback origin on this consent document.
    c.set("oauthFormRedirectOrigin", new URL(request.redirectUri).origin);
    return c.html(
      page(
        "Connect your coding agent",
        `<p>Connect <strong>${escape(client?.name ?? "Coding agent")}</strong> to Traceyard. You can give it access to a project when you’re ready.</p>
        <form method="post" action="/oauth/authorize">
          <input type="hidden" name="consent" value="${escape(csrf)}">
          <div class="actions"><button name="decision" value="approve">Connect agent</button><button class="secondary" name="decision" value="deny">Cancel</button></div>
        </form>`,
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
        body.get("project") || null,
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
  app.get("/oauth/connections", async (c) => {
    const auth = c.get("auth");
    const requested = c.req.query("connection");
    if (!auth)
      return c.html(
        page(
          "Manage coding agents",
          `<p>Sign in to manage your coding agents.</p><a class="button" href="/api/auth/github/start?returnTo=${encodeURIComponent(
            requested && /^grant_[a-f0-9]{32}$/.test(requested)
              ? "/oauth/connections?connection=" + requested
              : "/oauth/connections",
          )}">Continue with GitHub</a>`,
        ),
        401,
      );
    const connections = await c.env.DB.prepare(
      "SELECT g.id,c.name,g.scopes_json FROM mcp_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE g.owner_user_id=? AND g.project_id IS NULL AND g.revoked_at IS NULL ORDER BY g.created_at DESC",
    )
      .bind(auth.user.id)
      .all<{ id: string; name: string; scopes_json: string }>();
    const projects = await listOwnedProjects(c.env.DB, auth.user.id);
    const permissions = await c.env.DB.prepare(
      "SELECT a.grant_id,a.project_id FROM mcp_project_permissions a JOIN mcp_grants g ON g.id=a.grant_id WHERE g.owner_user_id=? AND g.revoked_at IS NULL",
    )
      .bind(auth.user.id)
      .all<{ grant_id: string; project_id: string }>();
    const body = connections.results
      .filter((connection) => !requested || requested === connection.id)
      .map((connection) => {
        const allowed = new Set(
          permissions.results.filter((p) => p.grant_id === connection.id).map((p) => p.project_id),
        );
        const scopes = JSON.parse(connection.scopes_json) as string[];
        const actions = [
          scopes.includes("investigations:read") && "read investigation evidence",
          scopes.includes("investigations:run") && "run supported tests and verify repairs",
          scopes.includes("runs:recover") && "recover workflows",
        ]
          .filter(Boolean)
          .join(", ");
        const rows = projects
          .map(
            (project) => `<form class="project-access" method="post" action="/oauth/connections">
        <input type="hidden" name="connection" value="${escape(connection.id)}">
        <input type="hidden" name="project" value="${escape(project.id)}">
        <p>${escape(project.repository ?? project.name)}</p>
        <button name="decision" value="${allowed.has(project.id) ? "remove" : "allow"}">${allowed.has(project.id) ? "Remove access" : "Allow access"}</button>
      </form>`,
          )
          .join("");
        return `<section class="connection"><h2>${escape(connection.name)}</h2><p>For each project you allow, this agent can ${escape(actions)}.</p>
        ${rows || "<p>No projects yet.</p>"}
        <form method="post" action="/oauth/connections"><input type="hidden" name="connection" value="${escape(connection.id)}"><button class="secondary" name="decision" value="disconnect">Disconnect agent</button></form></section>`;
      })
      .join("");
    return c.html(
      page(
        "Manage coding agents",
        `${body || "<p>No matching connection.</p>"}<p><a href="/projects">Connect a repository</a> · <a href="/oauth/connections">All agents</a></p>`,
      ),
    );
  });
  app.post("/oauth/connections", async (c) => {
    const auth = c.get("auth");
    if (!auth) throw badRequest("SIGN_IN_REQUIRED", "Sign in to manage your coding agents.");
    const fields = await form(c);
    const grant = fields.get("connection") ?? "";
    const project = fields.get("project") ?? "";
    const owner = auth.user.id;
    const decision = fields.get("decision");
    const activeConnection =
      "SELECT id FROM mcp_grants WHERE id=? AND owner_user_id=? AND project_id IS NULL AND revoked_at IS NULL";
    if (decision === "allow") {
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO mcp_project_permissions(grant_id,project_id)
        SELECT g.id,p.id FROM (${activeConnection}) g CROSS JOIN projects p WHERE p.id=? AND p.owner_user_id=?`,
      )
        .bind(grant, owner, project, owner)
        .run();
    } else if (decision === "remove") {
      await c.env.DB.prepare(
        `DELETE FROM mcp_project_permissions WHERE grant_id IN (${activeConnection}) AND project_id=?`,
      )
        .bind(grant, owner, project)
        .run();
    } else if (decision === "disconnect") {
      await c.env.DB.prepare(
        "UPDATE mcp_grants SET revoked_at=? WHERE id=? AND owner_user_id=? AND project_id IS NULL AND revoked_at IS NULL",
      )
        .bind(nowIso(), grant, owner)
        .run();
    } else {
      throw badRequest("INVALID_DECISION", "Choose an access action.");
    }
    return c.redirect(
      decision === "disconnect"
        ? "/oauth/connections"
        : "/oauth/connections?connection=" + encodeURIComponent(grant),
      303,
    );
  });
  app.get("/api/projects/:projectId/agent-connections", async (c) => {
    const { projectId, userId } = await ownedProject(c);
    const rows = await c.env.DB.prepare(
      "SELECT g.id,c.name,g.scopes_json,g.created_at,g.revoked_at FROM mcp_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE g.owner_user_id=? AND (g.project_id=? OR (g.project_id IS NULL AND g.revoked_at IS NULL AND EXISTS(SELECT 1 FROM mcp_project_permissions a WHERE a.grant_id=g.id AND a.project_id=?))) ORDER BY g.created_at DESC LIMIT 50",
    )
      .bind(userId, projectId, projectId)
      .all();
    return c.json({ data: { items: rows.results } });
  });
  app.post("/api/projects/:projectId/agent-connections/:id/revoke", async (c) => {
    const { projectId, userId } = await ownedProject(c);
    const grant = c.req.param("id");
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE mcp_grants SET revoked_at=? WHERE id=? AND project_id=? AND owner_user_id=?",
      ).bind(nowIso(), grant, projectId, userId),
      c.env.DB.prepare(
        "DELETE FROM mcp_project_permissions WHERE grant_id=? AND project_id=? AND EXISTS(SELECT 1 FROM mcp_grants g WHERE g.id=? AND g.owner_user_id=? AND g.project_id IS NULL)",
      ).bind(grant, projectId, grant, userId),
    ]);
    return c.json({ data: { revoked: true } });
  });
  return app;
}
