import { describe, it, expect } from "vitest";
import { env, type WorkflowStep } from "cloudflare:workers";
import { createExecutionContext, introspectWorkflowInstance } from "cloudflare:test";
import { createApp } from "../../worker/api/app";
import { createSession, apiFetchWithGitHub, ORIGIN, readSuccess } from "./helpers";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import { base64UrlEncode } from "../../worker/lib/crypto";
import { scanRepository } from "../../worker/repositories/scan";
async function account(id = 810) {
  const user = await getOrCreateGitHubIdentity(env.DB, {
    id,
    login: "repository-" + id,
    name: "Repository owner",
    avatarUrl: null,
  });
  const auth = await createUserSession(env.DB, user.id, new Request(ORIGIN));
  return {
    cookie: (await createSession()).cookie + "; ty_auth_session=" + auth.token,
    projectId: (await getDefaultProjectId(env.DB, user.id))!,
  };
}
const noExternal: typeof fetch = async () => {
  throw Error("Unexpected external call");
};
function call(
  a: { cookie: string },
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
  fetcher: typeof fetch = noExternal,
) {
  return apiFetchWithGitHub(
    path,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    fetcher,
    a.cookie,
  );
}
async function key(a: Awaited<ReturnType<typeof account>>) {
  return readSuccess<{ token: string }>(
    await call(a, "/api/projects/" + a.projectId + "/keys", "POST", {
      name: "Local runner",
      scopes: ["traces:write"],
    }),
  );
}
const report = (id: string, phase: string, status: string, extra = {}) => ({
  id,
  sha: "a".repeat(40),
  phase,
  status,
  message: "Runner report",
  ...extra,
});
describe("repository connection and execution evidence", () => {
  it("bounds free discovery, isolates a failed file, and persists metadata without credentials or source", async () => {
    const a = await account();
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const pem =
      "-----BEGIN PRIVATE KEY-----\n" +
      btoa(
        String.fromCharCode(
          ...new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
        ),
      ) +
      "\n-----END PRIVATE KEY-----";
    const configured = {
      ...env,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: pem,
      SOURCE_SCAN_FILE_LIMIT: "16",
      SOURCE_SCAN_FILE_BYTES: "16000",
    };
    await env.DB.prepare(
      "INSERT INTO project_repositories(project_id,full_name,default_branch,status,updated_at) VALUES(?,'repository-810/app','main','DISCOVERING',?)",
    )
      .bind(a.projectId, new Date().toISOString())
      .run();
    let requests = 0;
    const fetcher: typeof fetch = async (input) => {
      requests++;
      const url = String(input);
      if (url.endsWith("/access_tokens"))
        return Response.json({ token: "never-persist-installation-token" });
      if (url.includes("/commits/")) return Response.json({ sha: "a".repeat(40) });
      if (url.includes("/git/trees/"))
        return Response.json({
          truncated: false,
          tree: [
            { path: "large.ts", type: "blob", size: 20000, sha: "large" },
            ...Array.from({ length: 20 }, (_, i) => ({
              path: `api/route-${i}.ts`,
              type: "blob",
              size: 100,
              sha: String(i),
            })),
          ],
        });
      if (url.includes("/git/blobs/"))
        return Response.json({
          encoding: "base64",
          content: btoa("// private-source-marker\napp.get('/health', () => loadHealth());"),
        });
      throw Error("Unexpected GitHub request");
    };
    const persisted = new Map<string, unknown>();
    const step = {
      do: async (name: string, _options: unknown, fn: () => Promise<unknown>) => {
        if (persisted.has(name)) return persisted.get(name);
        if (name === "source-file-1") throw Error("CPU limit simulated");
        const result = await fn();
        persisted.set(name, result);
        return result;
      },
    } as unknown as WorkflowStep;
    const repo = {
      project_id: a.projectId,
      installation_id: 7,
      full_name: "repository-810/app",
      default_branch: "main",
    };
    await scanRepository(configured, repo, fetcher, step);
    const firstRequests = requests;
    // Workflow replay must reuse persisted outputs rather than refetching completed source.
    await scanRepository(configured, repo, fetcher, step);
    expect(requests).toBe(firstRequests);
    expect(requests).toBeLessThan(40);
    const row = await env.DB.prepare(
      "SELECT scan_json,status FROM project_repositories WHERE project_id=?",
    )
      .bind(a.projectId)
      .first<{ scan_json: string; status: string }>();
    expect(row?.status).toBe("DISCOVERED");
    expect(JSON.parse(row!.scan_json)).toMatchObject({ filesScanned: 15, totalFiles: 16 });
    expect(JSON.parse(row!.scan_json).operations).toHaveLength(15);
    expect(JSON.parse(row!.scan_json).warnings.join(" ")).toContain("16 source files");
    expect(JSON.parse(row!.scan_json).warnings.join(" ")).toContain("Could not analyse");
    const state = JSON.stringify([...persisted]);
    expect(state).not.toContain("never-persist-installation-token");
    expect(state).not.toContain("private-source-marker");
    expect(state).not.toContain("PRIVATE KEY");
  });
  it("keeps repository state owner-scoped and exposes missing GitHub configuration honestly", async () => {
    const a = await account(),
      b = await account(811);
    expect(
      await readSuccess(await call(a, "/api/projects/" + a.projectId + "/repository")),
    ).toEqual({ repository: null, jobs: [] });
    expect((await call(b, "/api/projects/" + a.projectId + "/repository")).status).toBe(404);
    expect(await readSuccess(await call(a, "/api/repositories"))).toMatchObject({
      configured: false,
      installationCount: 0,
      manageUrl: null,
      items: [],
    });
    expect((await call(a, "/api/github/webhook", "POST", { action: "created" })).status).toBe(403);
  });
  it("accepts local discovery and real phase evidence, rejects unsupported success, and never rewrites terminal results", async () => {
    const a = await account(),
      token = (await key(a)).token;
    expect(
      (await call(a, "/api/v1/repository/register", "POST", { name: "Somni" }, token)).status,
    ).toBe(200);
    expect(
      (
        await call(
          a,
          "/api/v1/repository-runs",
          "POST",
          report("local-1", "complete", "SUCCEEDED"),
          token,
        )
      ).status,
    ).toBe(400);
    const operation = {
      id: "server.ts:1:POST /interpret",
      name: "POST /interpret",
      kind: "http",
      file: "server.ts",
      line: 1,
      calls: ["model.generate"],
      evidence: "source",
    };
    expect(
      (
        await call(
          a,
          "/api/v1/repository-runs",
          "POST",
          report("local-1", "discovery", "SUCCEEDED", {
            operations: [operation],
            filesScanned: 1,
            warnings: [],
          }),
          token,
        )
      ).status,
    ).toBe(200);
    await call(a, "/api/v1/repository-runs", "POST", report("local-1", "test", "SUCCEEDED"), token);
    expect(
      (
        await call(
          a,
          "/api/v1/repository-runs",
          "POST",
          report("local-1", "install", "RUNNING"),
          token,
        )
      ).status,
    ).toBe(409);
    await call(
      a,
      "/api/v1/repository-runs",
      "POST",
      report("local-1", "complete", "SUCCEEDED"),
      token,
    );
    await call(
      a,
      "/api/v1/repository-runs",
      "POST",
      report("local-1", "complete", "FAILED"),
      token,
    );
    const data = await readSuccess<{
      repository: { scan_json: string };
      jobs: { status: string }[];
    }>(await call(a, "/api/projects/" + a.projectId + "/repository"));
    expect(JSON.parse(data.repository.scan_json).operations).toEqual([operation]);
    expect(data.jobs[0]?.status).toBe("SUCCEEDED");
  });
  it("ingests automatic OTLP root/child spans into the same project activity view and protects scope", async () => {
    const a = await account(),
      b = await account(811),
      token = (await key(a)).token;
    const spans = [
      {
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
        name: "POST /interpret",
        startTimeUnixNano: "1760000000000000000",
        endTimeUnixNano: "1760000001000000000",
        status: { code: 2 },
      },
      {
        traceId: "1".repeat(32),
        spanId: "3".repeat(16),
        parentSpanId: "2".repeat(16),
        name: "model request",
        startTimeUnixNano: "1760000000100000000",
        endTimeUnixNano: "1760000000900000000",
        status: { code: 2 },
      },
    ];
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "Somni" } },
              { key: "traceyard.run.id", value: { stringValue: "local-proof" } },
            ],
          },
          scopeSpans: [{ spans }],
        },
      ],
    };
    expect((await call(a, "/api/v1/otlp/v1/traces", "POST", body, token)).status).toBe(200);
    const activity = await readSuccess<{
      items: { name: string; steps: number; status: string; source: string }[];
    }>(await call(a, "/api/projects/" + a.projectId + "/activity"));
    expect(activity.items[0]).toMatchObject({
      name: "POST /interpret",
      steps: 2,
      status: "FAILED",
      source: "application",
    });
    expect(
      (
        await readSuccess<{ items: unknown[] }>(
          await call(a, "/api/projects/" + a.projectId + "/activity?checkRun=local-proof"),
        )
      ).items,
    ).toHaveLength(1);
    expect(
      (
        await readSuccess<{ items: unknown[] }>(
          await call(a, "/api/projects/" + a.projectId + "/activity?checkRun=missing"),
        )
      ).items,
    ).toHaveLength(0);
    expect(await readSuccess(await call(b, "/api/projects/" + b.projectId + "/activity"))).toEqual({
      items: [],
    });
  });
  it("verifies GitHub OIDC signature, audience, workflow, repository owner and branch before accepting results", async () => {
    const a = await account();
    await env.DB.prepare("INSERT INTO github_installations VALUES(7,'810','repository-810',0,?)")
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      "INSERT INTO project_repositories(project_id,repository_id,installation_id,full_name,default_branch,updated_at) VALUES(?,99,7,'repository-810/somni','main',?)",
    )
      .bind(a.projectId, new Date().toISOString())
      .run();
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const publicKey = {
      ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
      kid: "test-key",
    };
    const fetcher: typeof fetch = async (input) => {
      expect(String(input)).toBe("https://token.actions.githubusercontent.com/.well-known/jwks");
      return Response.json({ keys: [publicKey] });
    };
    const payload = {
      iss: "https://token.actions.githubusercontent.com",
      aud: ORIGIN,
      nbf: Math.floor(Date.now() / 1000) - 10,
      exp: Math.floor(Date.now() / 1000) + 300,
      runner_environment: "github-hosted",
      event_name: "push",
      repository_id: "99",
      repository_owner_id: "810",
      ref: "refs/heads/main",
      workflow_ref: "repository-810/somni/.github/workflows/traceyard.yml@refs/heads/main",
      sha: "a".repeat(40),
      run_id: "100",
      run_attempt: "1",
    };
    async function token(changes = {}) {
      const enc = (v: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(v)));
      const input = enc({ alg: "RS256", kid: "test-key" }) + "." + enc({ ...payload, ...changes });
      return (
        input +
        "." +
        base64UrlEncode(
          new Uint8Array(
            await crypto.subtle.sign(
              "RSASSA-PKCS1-v1_5",
              pair.privateKey,
              new TextEncoder().encode(input),
            ),
          ),
        )
      );
    }
    expect(
      (
        await call(
          a,
          "/api/v1/repository-runs",
          "POST",
          report("100-1", "discovery", "RUNNING"),
          await token(),
          fetcher,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          a,
          "/api/v1/repository-runs",
          "POST",
          report("100-1", "test", "RUNNING"),
          await token({ aud: "https://evil.test" }),
          fetcher,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          a,
          "/api/v1/repository-runs",
          "POST",
          report("100-1", "test", "RUNNING"),
          await token({ ref: "refs/heads/other" }),
          fetcher,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          a,
          "/api/v1/repository-runs",
          "POST",
          report("999-1", "test", "RUNNING"),
          await token(),
          fetcher,
        )
      ).status,
    ).toBe(403);
    await env.DB.prepare("UPDATE github_installations SET suspended=1 WHERE id=7").run();
    expect(
      (
        await call(
          a,
          "/api/v1/repository-runs",
          "POST",
          report("100-1", "test", "RUNNING"),
          await token(),
          fetcher,
        )
      ).status,
    ).toBe(401);
  });
  it("accepts signed personal installation events and scans the exact GitHub commit through the API", async () => {
    const a = await account();
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const privatePem =
      "-----BEGIN PRIVATE KEY-----\n" +
      btoa(
        String.fromCharCode(
          ...new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
        ),
      ) +
      "\n-----END PRIVATE KEY-----";
    const configured = {
      ...env,
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "test-traceyard",
      TRACEYARD_RUNNER_REF: "c".repeat(40),
      GITHUB_APP_PRIVATE_KEY: privatePem,
      GITHUB_APP_WEBHOOK_SECRET: "local-test-secret",
    };
    const raw = JSON.stringify({
      action: "created",
      installation: { id: 7, account: { id: 810, login: "repository-810", type: "User" } },
    });
    const hmac = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("local-test-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = Array.from(
      new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(raw))),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    const app = createApp();
    const response = await app.fetch(
      new Request(ORIGIN + "/api/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-hub-signature-256": "sha256=" + signature,
        },
        body: raw,
      }),
      configured,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    await env.DB.prepare(
      "INSERT INTO project_repositories(project_id,repository_id,installation_id,full_name,default_branch,updated_at) VALUES(?,99,7,'repository-810/somni','main',?)",
    )
      .bind(a.projectId, new Date().toISOString())
      .run();
    const source = "app.post('/interpret',async c=>model.generate(c));";
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/access_tokens"))
        return Response.json({ token: "test-installation-token" });
      if (url.includes("/installation/repositories"))
        return Response.json({
          repositories: [
            {
              id: 99,
              full_name: "repository-810/somni",
              default_branch: "main",
              owner: { id: 810, type: "User" },
            },
          ],
        });
      if (url.includes("/git/ref/heads/")) return new Response(null, { status: 404 });
      if (url.includes("/pulls?")) return Response.json([]);
      if (url.includes("/contents/.github/workflows/traceyard.yml") && init?.method !== "PUT")
        return new Response(null, { status: 404 });
      if (url.endsWith("/git/refs")) return Response.json({ ref: "refs/heads/setup" });
      if (url.includes("/contents/.github/workflows/traceyard.yml"))
        return Response.json({ commit: { sha: "d".repeat(40) } });
      if (url.endsWith("/pulls"))
        return Response.json({ html_url: "https://github.com/repository-810/somni/pull/1" });
      if (url.includes("/dispatches")) return new Response(null, { status: 204 });
      if (url.endsWith("/cancel")) return new Response(null, { status: 202 });
      if (url.endsWith("/commits/main")) return Response.json({ sha: "a".repeat(40) });
      if (url.includes("/git/trees/"))
        return Response.json({
          truncated: false,
          tree: [{ path: "server.ts", type: "blob", size: source.length, sha: "b".repeat(40) }],
        });
      if (url.includes("/git/blobs/"))
        return Response.json({ encoding: "base64", content: btoa(source) });
      throw Error("Unexpected URL");
    };
    await scanRepository(
      configured,
      {
        project_id: a.projectId,
        installation_id: 7,
        full_name: "repository-810/somni",
        default_branch: "main",
      },
      fetcher,
    );
    const repo = await env.DB.prepare(
      "SELECT commit_sha,scan_json,status FROM project_repositories WHERE project_id=?",
    )
      .bind(a.projectId)
      .first<{ commit_sha: string; scan_json: string; status: string }>();
    expect(repo?.commit_sha).toBe("a".repeat(40));
    expect(repo?.status).toBe("DISCOVERED");
    expect(JSON.parse(repo!.scan_json).operations[0].name).toBe("POST /interpret");
    const connectedApp = createApp({ githubFetch: fetcher });
    const invoke = (path: string, method = "GET") =>
      connectedApp.fetch(
        new Request(ORIGIN + path, { method, headers: { cookie: a.cookie, origin: ORIGIN } }),
        configured,
        createExecutionContext(),
      );
    const listed = await readSuccess<{ items: { id: number }[] }>(
      await invoke("/api/repositories"),
    );
    expect(listed.items[0]?.id).toBe(99);
    expect(
      (await invoke("/api/projects/" + a.projectId + "/repository/setup", "POST")).status,
    ).toBe(400);
    expect((await invoke("/api/projects/" + a.projectId + "/repository/run", "POST")).status).toBe(
      503,
    );
    async function webhook(body: unknown) {
      const text = JSON.stringify(body),
        bytes = await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(text));
      const sig = Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join(
        "",
      );
      return app.fetch(
        new Request(ORIGIN + "/api/github/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": (body as { installation?: unknown }).installation
              ? "installation"
              : "workflow_run",
            "x-hub-signature-256": "sha256=" + sig,
          },
          body: text,
        }),
        configured,
        createExecutionContext(),
      );
    }
    const workflow = {
      id: 555,
      run_attempt: 1,
      path: ".github/workflows/traceyard.yml",
      head_branch: "main",
      head_sha: "a".repeat(40),
      head_repository: { id: 99 },
      conclusion: null as string | null,
    };
    expect(
      (await webhook({ action: "in_progress", repository: { id: 99 }, workflow_run: workflow }))
        .status,
    ).toBe(200);
    expect(
      (await invoke("/api/projects/" + a.projectId + "/checks/555-1/cancel", "POST")).status,
    ).toBe(202);
    expect(
      await env.DB.prepare("SELECT status FROM repository_jobs WHERE project_id=? AND id='555-1'")
        .bind(a.projectId)
        .first(),
    ).toEqual({ status: "RUNNING" });
    await webhook({
      action: "completed",
      repository: { id: 99 },
      workflow_run: { ...workflow, conclusion: "cancelled" },
    });
    expect(
      await env.DB.prepare("SELECT status FROM repository_jobs WHERE project_id=? AND id='555-1'")
        .bind(a.projectId)
        .first(),
    ).toEqual({ status: "CANCELLED" });
    await webhook({
      action: "deleted",
      installation: { id: 7, account: { id: 810, login: "repository-810", type: "User" } },
    });
    await webhook(JSON.parse(raw));
    expect(
      await env.DB.prepare("SELECT suspended FROM github_installations WHERE id=7").first(),
    ).toEqual({ suspended: 1 });
  });
  it("creates one project per repository and discovers source without modifying customer workflows", async () => {
    const a = await account(),
      other = await account(811);
    await env.DB.prepare(
      "INSERT INTO github_installations(id,account_id,account_login,updated_at) VALUES(7,'810','repository-810',?)",
    )
      .bind(new Date().toISOString())
      .run();
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const tasks: { params: { projectId: string; checks?: boolean } }[] = [];
    const configured = {
      ...env,
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "traceyard-test",
      GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\n" +
        btoa(
          String.fromCharCode(
            ...new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
          ),
        ) +
        "\n-----END PRIVATE KEY-----",
      GITHUB_APP_WEBHOOK_SECRET: "test-only",
      TRACEYARD_RUNNER_REF: "c".repeat(40),
      REPOSITORY_DISCOVERY: {
        create: async (task: { params: { projectId: string; checks?: boolean } }) => {
          tasks.push(task);
          return {};
        },
      } as unknown as NonNullable<Env["REPOSITORY_DISCOVERY"]>,
    };
    let branch = false,
      file: string | null = null,
      pr = false;
    const failUpload = true;
    let branches = 0,
      prs = 0,
      dispatches = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) return Response.json({ token: "fixture-token" });
      if (url.includes("/installation/repositories"))
        return Response.json({ repositories: [{ id: 99, full_name: "repository-810/somni" }] });
      if (url.endsWith("/repositories/99"))
        return Response.json({
          id: 99,
          full_name: "repository-810/somni",
          default_branch: "main",
          owner: { id: 810, type: "User" },
        });
      if (url.includes("/git/ref/heads/"))
        return branch ? Response.json({ ref: "existing" }) : new Response(null, { status: 404 });
      if (url.endsWith("/git/refs")) {
        branch = true;
        branches++;
        return Response.json({});
      }
      if (url.includes("/commits/main")) return Response.json({ sha: "a".repeat(40) });
      if (url.includes("/contents/.github/workflows/traceyard.yml")) {
        if (init?.method === "PUT") {
          if (failUpload) return new Response(null, { status: 500 });
          file = JSON.parse(String(init.body)).content;
          return Response.json({});
        }
        return file ? Response.json({ content: file }) : new Response(null, { status: 404 });
      }
      if (url.includes("/pulls?"))
        return Response.json(
          pr ? [{ html_url: "https://github.com/repository-810/somni/pull/8" }] : [],
        );
      if (url.endsWith("/pulls")) {
        pr = true;
        prs++;
        return Response.json({ html_url: "https://github.com/repository-810/somni/pull/8" });
      }
      if (url.includes("/dispatches")) {
        dispatches++;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/git/trees/"))
        return Response.json({
          truncated: false,
          tree: [{ path: "server.ts", type: "blob", size: 50, sha: "b".repeat(40) }],
        });
      if (url.includes("/git/blobs/"))
        return Response.json({
          encoding: "base64",
          content: btoa("app.post('/interpret',async()=>model.generate());"),
        });
      throw Error("Unexpected fixture request: " + url);
    };
    const app = createApp({ githubFetch: fetcher });
    const invoke = (path: string, method = "POST", body?: unknown, cookie = a.cookie) =>
      app.fetch(
        // Dev Tunnels rewrites Origin to its local HTTP target; Vite uses the
        // forwarded HTTPS protocol when constructing the Worker request URL.
        new Request("https://localhost:5173" + path, {
          method,
          headers: {
            cookie,
            origin: "http://localhost:5173",
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        configured,
        createExecutionContext(),
      );
    expect(await readSuccess(await invoke("/api/repositories", "GET"))).toMatchObject({
      installationCount: 1,
      manageUrl: "https://github.com/settings/installations/7",
      items: [{ id: 99, name: "repository-810/somni", installationId: 7 }],
    });
    expect(
      await readSuccess(await invoke("/api/repositories", "GET", undefined, other.cookie)),
    ).toMatchObject({
      installationCount: 0,
      manageUrl: null,
      items: [],
    });
    const input = { repositoryId: 99, installationId: 7 };
    expect((await invoke("/api/repositories/connect", "POST", input, other.cookie)).status).toBe(
      404,
    );
    const first = await readSuccess<{ project: { id: string; name: string } }>(
      await invoke("/api/repositories/connect", "POST", input),
    );
    const id = first.project.id;
    expect(id).not.toBe(a.projectId);
    expect(first.project.name).toBe("repository-810/somni");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.params).toMatchObject({ projectId: id, checks: true });
    const again = await readSuccess<{ project: { id: string }; existing: boolean }>(
      await invoke("/api/repositories/connect", "POST", input),
    );
    expect(again).toMatchObject({ project: { id }, existing: true });
    expect(tasks).toHaveLength(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM projects WHERE owner_user_id=(SELECT owner_user_id FROM projects WHERE id=?)",
        )
          .bind(id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(2);
    await scanRepository(
      configured,
      {
        project_id: id,
        installation_id: 7,
        full_name: "repository-810/somni",
        default_branch: "main",
      },
      fetcher,
    );
    expect(
      await env.DB.prepare(
        "SELECT status,setup_pr_url FROM project_repositories WHERE project_id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({ status: "DISCOVERED", setup_pr_url: null });
    expect((await invoke(`/api/projects/${id}/repository/setup`)).status).toBe(400);
    expect((await invoke(`/api/projects/${id}/repository/run`)).status).toBe(503);
    expect(branches).toBe(0);
    expect(prs).toBe(0);
    expect(dispatches).toBe(0);
  });
  it("finishes independent background setup stages and retains both failures without configured services", async () => {
    const a = await account();
    const scanId = "scan-background-" + crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO github_installations(id,account_id,account_login,updated_at) VALUES(7,'810','repository-810',?)",
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      "INSERT INTO project_repositories(project_id,repository_id,installation_id,full_name,default_branch,scan_id,status,updated_at) VALUES(?,99,7,'repository-810/somni','main',?,'DISCOVERING',?)",
    )
      .bind(a.projectId, scanId, new Date().toISOString())
      .run();
    await using instance = await introspectWorkflowInstance(env.REPOSITORY_DISCOVERY!, scanId);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    await env.REPOSITORY_DISCOVERY!.create({
      id: scanId,
      params: { projectId: a.projectId, scanId, checks: true },
    });
    await instance.waitForStatus("complete");
    const state = await env.DB.prepare(
      "SELECT status,last_error,check_setup_state,check_setup_error FROM project_repositories WHERE project_id=?",
    )
      .bind(a.projectId)
      .first<{
        status: string;
        last_error: string;
        check_setup_state: string;
        check_setup_error: string;
      }>();
    expect(state?.status).toBe("FAILED");
    expect(state?.last_error).toContain("GitHub App configuration");
    expect(state?.check_setup_state).toBe("NOT_STARTED");
    expect(state?.check_setup_error).toBeNull();
  });
});
