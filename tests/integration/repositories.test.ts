import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
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
  it("keeps repository state owner-scoped and exposes missing GitHub configuration honestly", async () => {
    const a = await account(),
      b = await account(811);
    expect(
      await readSuccess(await call(a, "/api/projects/" + a.projectId + "/repository")),
    ).toEqual({ repository: null, jobs: [] });
    expect((await call(b, "/api/projects/" + a.projectId + "/repository")).status).toBe(404);
    expect(await readSuccess(await call(a, "/api/repositories"))).toMatchObject({
      configured: false,
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
    const fetcher: typeof fetch = async (input) => {
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
      if (url.endsWith("/git/refs")) return Response.json({ ref: "refs/heads/setup" });
      if (url.includes("/contents/.github/workflows/traceyard.yml"))
        return Response.json({ commit: { sha: "d".repeat(40) } });
      if (url.endsWith("/pulls"))
        return Response.json({ html_url: "https://github.com/repository-810/somni/pull/1" });
      if (url.includes("/dispatches")) return new Response(null, { status: 204 });
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
    ).toBe(201);
    expect(
      (await invoke("/api/projects/" + a.projectId + "/repository/setup", "POST")).status,
    ).toBe(200);
    expect((await invoke("/api/projects/" + a.projectId + "/repository/run", "POST")).status).toBe(
      202,
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
});
