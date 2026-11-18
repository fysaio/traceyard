import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import { sha256Base64Url } from "../../worker/lib/crypto";
import { apiFetch, createSession, ORIGIN } from "./helpers";
async function account(id = 950) {
  const user = await getOrCreateGitHubIdentity(env.DB, {
      id,
      login: `agent-${id}`,
      name: "Owner",
      avatarUrl: null,
    }),
    session = await createUserSession(env.DB, user.id, new Request(ORIGIN));
  return {
    cookie: (await createSession()).cookie + "; ty_auth_session=" + session.token,
    projectId: (await getDefaultProjectId(env.DB, user.id))!,
  };
}
async function connect(scope = "investigations:read investigations:run", accountOnly = false) {
  const a = await account(),
    verifier = "v".repeat(64),
    redirect = "https://agent.example/callback";
  const registration = await apiFetch("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Fixture coding agent",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registration.status).toBe(201);
  const client = (await registration.json()) as { client_id: string };
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: await sha256Base64Url(verifier),
    state: "retained-state",
    scope,
    resource: ORIGIN + "/mcp",
  });
  const authorize = await apiFetch("/oauth/authorize?" + query, { headers: { cookie: a.cookie } }),
    html = await authorize.text(),
    consent = /name="consent" value="([^"]+)"/.exec(html)?.[1];
  expect(consent).toBeTruthy();
  const approved = await apiFetch("/oauth/authorize", {
    method: "POST",
    redirect: "manual",
    headers: { cookie: a.cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      consent: consent!,
      ...(accountOnly ? {} : { project: a.projectId }),
      decision: "approve",
    }).toString(),
  });
  expect(approved.status).toBe(302);
  const returned = new URL(approved.headers.get("location")!);
  expect(returned.searchParams.get("state")).toBe("retained-state");
  const fields = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: redirect,
    code_verifier: verifier,
    code: returned.searchParams.get("code")!,
    resource: ORIGIN + "/mcp",
  });
  const wrong = new URLSearchParams(fields);
  wrong.set("code_verifier", "w".repeat(64));
  expect(
    (
      await apiFetch("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: wrong.toString(),
      })
    ).status,
  ).toBe(400);
  const token = await apiFetch("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: fields.toString(),
  });
  expect(token.status).toBe(200);
  return {
    ...a,
    clientId: client.client_id,
    fields,
    token: (await token.json()) as { access_token: string; refresh_token: string },
  };
}
function client(token: string) {
  const c = new Client({ name: "traceyard-acceptance", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), {
    requestInit: { headers: { Authorization: "Bearer " + token } },
    fetch: async (input, init) => SELF.fetch(String(input), init as RequestInit),
  });
  return { c, transport };
}
describe("authenticated remote MCP", () => {
  it("connects without granting projects and enforces explicit, revocable project access", async () => {
    const a = await connect(undefined, true);
    const other = await account(965);
    const remote = client(a.token.access_token);
    await remote.c.connect(remote.transport);
    try {
      const capabilities = await remote.c.callTool({
        name: "inspect",
        arguments: { section: "capabilities" },
      });
      expect(capabilities.structuredContent).toMatchObject({
        status: "PROJECT_ACCESS_REQUIRED",
        items: [],
      });
      const url = new URL((capabilities.structuredContent as { browserUrl: string }).browserUrl);
      const grant = url.searchParams.get("connection")!;
      const investigate = (projectId?: string) =>
        remote.c.callTool({
          name: "investigate",
          arguments: { projectId, question: "Inspect authorized project source" },
        });
      const manage = (decision: string, project: string, cookie = a.cookie, origin = ORIGIN) =>
        apiFetch("/oauth/connections", {
          method: "POST",
          redirect: "manual",
          headers: { cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ decision, project, connection: grant }).toString(),
        });
      expect((await investigate(a.projectId)).isError).toBe(true);
      expect((await manage("allow", a.projectId, a.cookie, "https://foreign.example")).status).toBe(
        403,
      );
      await manage("allow", other.projectId);
      await manage("allow", other.projectId, other.cookie);
      expect((await investigate(other.projectId)).isError).toBe(true);
      expect((await manage("allow", a.projectId)).status).toBe(303);
      expect((await investigate(a.projectId)).isError).not.toBe(true);
      expect((await investigate(other.projectId)).isError).toBe(true);
      const second = await apiFetch("/api/projects", {
        method: "POST",
        headers: { cookie: a.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Another approved project" }),
      });
      expect(second.status).toBe(201);
      const project = ((await second.json()) as { data: { id: string } }).data;
      await manage("allow", project.id);
      expect((await investigate()).structuredContent).toMatchObject({
        status: "PROJECT_SELECTION_REQUIRED",
      });
      expect((await investigate(project.id)).isError).not.toBe(true);
      await manage("remove", a.projectId);
      expect((await investigate(a.projectId)).isError).toBe(true);
      expect((await investigate(project.id)).isError).not.toBe(true);
    } finally {
      await remote.c.close();
    }
  });

  it("keeps authenticated GET open while POST tools and reconnect remain usable", async () => {
    const a = await connect();
    const headers = {
      Authorization: "Bearer " + a.token.access_token,
      Accept: "text/event-stream",
    };
    const stream = await apiFetch("/mcp", { headers });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.headers.get("cache-control")).toContain("no-transform");
    const reader = stream.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain(": connected");
    try {
      const errors: Error[] = [];
      const remote = client(a.token.access_token);
      remote.c.onerror = (error) => errors.push(error);
      try {
        await remote.c.connect(remote.transport);
        expect((await remote.c.listTools()).tools).toHaveLength(4);
        const finding = await remote.c.callTool({
          name: "investigate",
          arguments: {
            question: "Inspect streaming transport evidence",
            mode: "analyze",
            outputChars: 1000,
          },
        });
        expect(finding.isError).not.toBe(true);
        expect((await remote.c.listTools()).tools).toHaveLength(4);
        expect(errors).toEqual([]);
      } finally {
        await remote.c.close();
      }
    } finally {
      await reader.cancel();
    }
    // A fresh stream works after disconnect; there is no per-process session.
    const reopened = await apiFetch("/mcp", { headers });
    expect(reopened.status).toBe(200);
    await reopened.body!.cancel();
    expect(
      (await apiFetch("/mcp", { headers: { ...headers, Origin: "https://attacker.example" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await apiFetch("/mcp", {
          headers: { Authorization: headers.Authorization, Accept: "application/json" },
        })
      ).status,
    ).toBe(406);
    const deleted = await apiFetch("/mcp", { method: "DELETE", headers });
    expect(deleted.status).toBe(405);
    expect(deleted.headers.get("allow")).toBe("GET, POST, OPTIONS");
    expect((await apiFetch("/mcp", { headers: { Accept: "text/event-stream" } })).status).toBe(401);
  });
  it("keeps consent browser-compatible while rejecting untrusted origins and invalid projects", async () => {
    const a = await account(953),
      other = await account(954);
    const callback = "https://antigravity.google/oauth-callback";
    const registration = await apiFetch("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Google Antigravity", redirect_uris: [callback] }),
    });
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: callback,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: await sha256Base64Url("v".repeat(64)),
    });
    const response = await apiFetch("/oauth/authorize?" + query, { headers: { cookie: a.cookie } });
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://antigravity.google;",
    );
    const html = await response.text();
    expect(html).not.toContain('name="project"');
    const consent = /name="consent" value="([^"]+)"/.exec(html)![1]!;
    const fields = new URLSearchParams({ consent, project: a.projectId, decision: "approve" });
    const post = (origin: string, body = fields) =>
      apiFetch("/oauth/authorize", {
        method: "POST",
        redirect: "manual",
        headers: { origin, cookie: a.cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    for (const origin of ["null", "https://attacker.example"]) {
      const rejected = await post(origin);
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("content-type")).toContain("text/html");
      expect(await rejected.text()).toContain("Your agent is not connected yet");
    }
    const wrongProject = new URLSearchParams(fields);
    wrongProject.set("project", other.projectId);
    expect((await post(ORIGIN, wrongProject)).status).toBe(403);
    const approved = await post(ORIGIN);
    expect(approved.status).toBe(302);
    expect(approved.headers.get("referrer-policy")).toBe("no-referrer");
    expect(approved.headers.get("content-security-policy")).toContain("form-action 'self';");
    expect(new URL(approved.headers.get("location")!).origin).toBe("https://antigravity.google");
  });
  it("uses the SDK's OAuth discovery and registration flow without a pasted server key", async () => {
    const a = await account();
    let information: Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>,
      tokens: Awaited<ReturnType<OAuthClientProvider["tokens"]>>,
      verifier = "",
      code = "";
    const provider: OAuthClientProvider = {
      redirectUrl: "https://agent.example/callback",
      clientMetadata: {
        client_name: "SDK agent",
        redirect_uris: ["https://agent.example/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "investigations:read investigations:run",
      },
      clientInformation: () => information,
      saveClientInformation: (value) => {
        information = value;
      },
      tokens: () => tokens,
      saveTokens: (value) => {
        tokens = value;
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
      state: () => "sdk-state",
      redirectToAuthorization: async (url) => {
        const response = await apiFetch(url.pathname + url.search, {
            headers: { cookie: a.cookie },
          }),
          html = await response.text(),
          consent = /name="consent" value="([^"]+)"/.exec(html)![1]!;
        const approved = await apiFetch("/oauth/authorize", {
          method: "POST",
          redirect: "manual",
          headers: { cookie: a.cookie, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            consent,
            project: a.projectId,
            decision: "approve",
          }).toString(),
        });
        code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
      },
    };
    const options = {
      authProvider: provider,
      fetch: async (input: string | URL | Request, init?: RequestInit) =>
        SELF.fetch(String(input), init),
    };
    const transport = new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), options),
      initial = new Client({ name: "oauth-client", version: "1" });
    await expect(initial.connect(transport)).rejects.toThrow();
    expect(code).not.toBe("");
    await transport.finishAuth(code);
    expect(tokens?.access_token).toMatch(/^tym_/);
    await initial.close();
    const connected = new Client({ name: "oauth-client", version: "1" });
    await connected.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), options));
    expect((await connected.listTools()).tools).toHaveLength(4);
    await connected.close();
  });
  it("completes real SDK negotiation, tool discovery and a retained investigation across reconnect", async () => {
    const a = await connect(),
      first = client(a.token.access_token);
    await first.c.connect(first.transport);
    const tools = await first.c.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["investigate", "inspect", "verify", "recover"]);
    const response = await first.c.callTool({
      name: "investigate",
      arguments: { question: "Inspect available source", outputChars: 1000 },
    });
    expect(response.isError).not.toBe(true);
    const data = response.structuredContent as { investigationId: string; status: string };
    expect(data.investigationId).toMatch(/^inv_/);
    expect(JSON.stringify(response).length).toBeLessThan(1200);
    await first.c.close();
    const next = client(a.token.access_token);
    await next.c.connect(next.transport);
    const retained = await next.c.callTool({
      name: "inspect",
      arguments: { investigationId: data.investigationId, section: "status" },
    });
    expect((retained.structuredContent as { investigationId: string }).investigationId).toBe(
      data.investigationId,
    );
    await next.c.close();
  });
  it("rejects authorization-code replay and rotates refresh tokens without widening scope", async () => {
    const a = await connect("investigations:read");
    const post = (fields: URLSearchParams) =>
      apiFetch("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: fields.toString(),
      });
    expect((await post(a.fields)).status).toBe(400);
    const bad = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: a.clientId,
      refresh_token: a.token.refresh_token,
      scope: "runs:recover",
    });
    expect((await post(bad)).status).toBe(400);
    const refresh = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: a.clientId,
      refresh_token: a.token.refresh_token,
    });
    const rotated = await post(refresh);
    expect(rotated.status).toBe(200);
    expect((await post(refresh)).status).toBe(400);
    const limited = client(a.token.access_token);
    await limited.c.connect(limited.transport);
    await expect(
      limited.c.callTool({
        name: "investigate",
        arguments: { question: "Run the test", mode: "execute" },
      }),
    ).rejects.toThrow();
    await limited.c.close();
  });
  it("enforces project isolation and makes connection revocation effective immediately", async () => {
    const a = await connect(),
      other = await account(951),
      remote = client(a.token.access_token);
    await remote.c.connect(remote.transport);
    const foreign = await apiFetch(`/api/projects/${other.projectId}/investigations`, {
      method: "POST",
      headers: { cookie: other.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Inspect private source" }),
    });
    const body = (await foreign.json()) as { data: { id: string } };
    const denied = await remote.c.callTool({
      name: "inspect",
      arguments: { investigationId: body.data.id },
    });
    expect(denied.isError).toBe(true);
    const deniedStatus = await remote.c.callTool({
      name: "inspect",
      arguments: { investigationId: body.data.id, section: "status" },
    });
    expect(deniedStatus.isError).toBe(true);
    expect(deniedStatus.structuredContent).toMatchObject({ code: "NOT_FOUND" });
    await remote.c.close();
    const grants = await apiFetch(`/api/projects/${a.projectId}/agent-connections`, {
      headers: { cookie: a.cookie },
    });
    const g = (await grants.json()) as { data: { items: { id: string }[] } };
    expect(
      (
        await apiFetch(
          `/api/projects/${a.projectId}/agent-connections/${g.data.items[0]!.id}/revoke`,
          { method: "POST", headers: { cookie: a.cookie } },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await SELF.fetch(ORIGIN + "/mcp", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + a.token.access_token,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        })
      ).status,
    ).toBe(401);
  });
  it("publishes discovery metadata and rejects unregistered redirects and missing tokens", async () => {
    const metadata = await SELF.fetch(ORIGIN + "/.well-known/oauth-authorization-server");
    expect(
      ((await metadata.json()) as { code_challenge_methods_supported: string[] })
        .code_challenge_methods_supported,
    ).toEqual(["S256"]);
    const denied = await SELF.fetch(ORIGIN + "/mcp");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
    expect(
      (
        await apiFetch("/oauth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ redirect_uris: ["http://evil.example/callback"] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_grants").first<{ n: number }>())?.n,
    ).toBe(0);
  });
});
