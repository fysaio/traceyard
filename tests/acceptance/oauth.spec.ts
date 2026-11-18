import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function openConsent(page: Page) {
  await page.goto("/__acceptance/account");
  await page.getByRole("button", { name: "Open local test account" }).click();
  const response = await page.request.post("/api/projects", {
    data: { name: "OAuth browser selection" },
  });
  expect(response.status()).toBe(201);
  const project = (await response.json()).data;
  const metadata = await (
    await page.request.get("/.well-known/oauth-protected-resource/mcp")
  ).json();
  // Different host from the consent document: exercise Chromium's redirect CSP.
  const callback = "http://127.0.0.1:5173/__acceptance/agent-callback";
  await page.route(callback + "?*", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Agent callback received</h1>" }),
  );
  const registered = await page.request.post("/oauth/register", {
    data: {
      client_name: "Browser acceptance agent",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
    },
  });
  expect(registered.status()).toBe(201);
  const client = await registered.json();
  const verifier = "browser-verifier-" + "v".repeat(48);
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: callback,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: "browser-consent-state",
    scope: "investigations:read investigations:run",
    resource: metadata.resource,
  });
  const consent = await page.goto("/oauth/authorize?" + query);
  expect(consent?.headers()["referrer-policy"]).toBe("same-origin");
  await expect(page.getByLabel("Traceyard project")).toHaveValue("");
  await expect(page.getByText(/These are your existing Traceyard projects/)).toBeVisible();
  return { project, client, verifier, callback, metadata };
}

test("native consent form preserves Origin, selects one project and completes MCP authentication", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(150000);
  const { project, client, verifier, callback, metadata } = await openConsent(page);
  let submissions = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/oauth/authorize") submissions++;
  });
  await page.getByRole("button", { name: "Connect agent", exact: true }).click();
  await expect(page.getByLabel("Traceyard project")).toHaveValue("");
  expect(submissions).toBe(0);
  await page.getByLabel("Traceyard project").selectOption(project.id);
  const [post] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === "POST" && new URL(r.url()).pathname === "/oauth/authorize",
    ),
    page.getByRole("button", { name: "Connect agent", exact: true }).click(),
  ]);
  expect(post.headers()["origin"]).toBe(new URL(baseURL!).origin);
  await expect(page.getByRole("heading", { name: "Agent callback received" })).toBeVisible();
  const returned = new URL(page.url());
  expect(returned.origin).toBe(new URL(callback).origin);
  expect(returned.searchParams.get("state")).toBe("browser-consent-state");
  const tokenResponse = await page.request.post(baseURL + "/oauth/token", {
    form: {
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: callback,
      code_verifier: verifier,
      code: returned.searchParams.get("code")!,
      resource: metadata.resource,
    },
  });
  expect(tokenResponse.status()).toBe(200);
  const token = await tokenResponse.json();
  const sdk = new Client({ name: "browser-acceptance", version: "1" });
  const errors: Error[] = [];
  sdk.onerror = (error) => errors.push(error);
  let gets = 0;
  let resolveGet!: (status: number) => void;
  const backgroundGet = new Promise<number>((resolve) => {
    resolveGet = resolve;
  });
  // A strict GET consumer reproduces the installed Antigravity behavior:
  // 405 is a failure, and an immediately closed 200 is also a failure.
  const stream = await fetch(baseURL + "/mcp", {
    headers: { Authorization: "Bearer " + token.access_token, Accept: "text/event-stream" },
  });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
  try {
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(baseURL + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + token.access_token } },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (init?.method === "GET") {
            gets++;
            resolveGet(response.status);
            if (response.status !== 200)
              throw new Error("standalone SSE stream: " + response.statusText);
          }
          return response;
        },
      }),
    );
    expect(await backgroundGet).toBe(200);
    expect((await sdk.listTools()).tools.map((tool) => tool.name)).toEqual([
      "investigate",
      "inspect",
      "verify",
      "recover",
    ]);
    const finding = await sdk.callTool({
      name: "investigate",
      arguments: {
        mode: "analyze",
        question: "Inspect browser authorization evidence",
        outputChars: 1000,
      },
    });
    expect(finding.isError).not.toBe(true);
    const id = (finding.structuredContent as { investigationId: string }).investigationId;
    expect(id).toMatch(/^inv_/);
    const retained = await page.request.get(
      `${baseURL}/api/projects/${project.id}/investigations/${id}`,
    );
    expect(retained.status()).toBe(200);
    expect((await retained.json()).data.projectId).toBe(project.id);
    // Stay idle beyond typical proxy timeouts, then call tools on that connection.
    // Each read must be another heartbeat, never EOF; the SDK must not retry GET.
    for (let i = 0; i < 5; i++) {
      const frame = await reader.read();
      expect(frame.done).toBe(false);
      expect(new TextDecoder().decode(frame.value)).toContain(": keep-alive");
    }
    expect((await sdk.listTools()).tools).toHaveLength(4);
    expect(gets).toBe(1);
    expect(errors).toEqual([]);
    await sdk.close();
    const next = new Client({ name: "browser-reconnect", version: "1" });
    try {
      await next.connect(
        new StreamableHTTPClientTransport(new URL(baseURL + "/mcp"), {
          requestInit: { headers: { Authorization: "Bearer " + token.access_token } },
        }),
      );
      const inspected = await next.callTool({
        name: "inspect",
        arguments: { investigationId: id, section: "status" },
      });
      expect(inspected.isError).not.toBe(true);
    } finally {
      await next.close();
    }
    const grantsResponse = await page.request.get(
      `${baseURL}/api/projects/${project.id}/agent-connections`,
    );
    const grants = (await grantsResponse.json()).data.items;
    const grant = grants.find((g: { name: string }) => g.name === "Browser acceptance agent");
    expect(grant).toBeTruthy();
    expect(
      (
        await page.request.post(
          `${baseURL}/api/projects/${project.id}/agent-connections/${grant.id}/revoke`,
        )
      ).status(),
    ).toBe(200);
    expect((await reader.read()).done).toBe(true);
    const denied = await fetch(baseURL + "/mcp", {
      headers: { Authorization: "Bearer " + token.access_token, Accept: "text/event-stream" },
    });
    expect(denied.status).toBe(401);
    await denied.body?.cancel();
  } finally {
    await reader.cancel();
    await sdk.close();
  }
});

test("cancel returns to the agent without requiring a project or creating access", async ({
  page,
  baseURL,
}) => {
  await openConsent(page);
  const projects = await (await page.request.get(baseURL + "/api/projects")).json();
  const grants = async () => {
    const ids: string[] = [];
    for (const project of projects.data.items) {
      const response = await page.request.get(
        `${baseURL}/api/projects/${project.id}/agent-connections`,
      );
      ids.push(...(await response.json()).data.items.map((g: { id: string }) => g.id));
    }
    return ids.sort();
  };
  const before = await grants();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agent callback received" })).toBeVisible();
  const returned = new URL(page.url());
  expect(returned.searchParams.get("error")).toBe("access_denied");
  expect(returned.searchParams.has("code")).toBe(false);
  expect(await grants()).toEqual(before);
});
