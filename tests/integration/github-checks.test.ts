import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { base64UrlEncode } from "../../worker/lib/crypto";
import { createApp } from "../../worker/api/app";
import { createSession, ORIGIN, readSuccess } from "./helpers";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import {
  prepareGitHubChecks,
  dispatchGitHubChecks,
  bindGitHubDispatch,
  syncGitHubDispatches,
} from "../../worker/repositories/github-checks";
import { runnerWorkflow, DEFAULT_RUNNER_REF } from "../../worker/repositories/runner-workflow";

async function fixture() {
  const user = await getOrCreateGitHubIdentity(env.DB, {
    id: 981,
    login: "ci-owner",
    name: "Owner",
    avatarUrl: null,
  });
  const project = (await getDefaultProjectId(env.DB, user.id))!;
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO github_installations(id,account_id,account_login,updated_at) VALUES(9,'981','ci-owner',?)",
  )
    .bind(at)
    .run();
  await env.DB.prepare(
    "INSERT INTO project_repositories(project_id,repository_id,installation_id,full_name,default_branch,status,scan_json,updated_at) VALUES(?,89,9,'ci-owner/app','main','DISCOVERED',?,?)",
  )
    .bind(project, JSON.stringify({ operations: [], filesScanned: 1, warnings: [] }), at)
    .run();
  const key = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const configured: Env = {
    ...env,
    PUBLIC_APP_ORIGIN: "https://traceyard.example",
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "traceyard",
    GITHUB_APP_WEBHOOK_SECRET: "test-only",
    GITHUB_APP_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\n" +
      btoa(
        String.fromCharCode(
          ...new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey)),
        ),
      ) +
      "\n-----END PRIVATE KEY-----",
  };
  const publicKey = { ...(await crypto.subtle.exportKey("jwk", key.publicKey)), kid: "ci-fixture" };
  const workflow = runnerWorkflow(configured.PUBLIC_APP_ORIGIN!, DEFAULT_RUNNER_REF);
  const remote = {
    branch: "",
    exists: false,
    file: false,
    pr: false,
    merged: false,
    closed: false,
    baseSha: "a".repeat(40),
    previousWorkflow: null as string | null,
    head: "b".repeat(40),
    extraFile: false,
    tamper: false,
    uncertain: false,
    runs: [] as unknown[],
    writes: [] as { path: string; body: Record<string, unknown> }[],
    tokens: [] as unknown[],
  };
  const pull = () => ({
    number: 4,
    html_url: "https://github.com/ci-owner/app/pull/4",
    merged: remote.merged,
    state: remote.closed || remote.merged ? "closed" : "open",
    changed_files: remote.extraFile ? 2 : 1,
    head: { sha: remote.head, ref: remote.branch, repo: { id: 89 } },
    base: { ref: "main", repo: { id: 89 } },
  });
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === "https://token.actions.githubusercontent.com/.well-known/jwks")
      return Response.json({ keys: [publicKey] });
    const u = new URL(String(input)),
      method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (u.pathname.endsWith("/access_tokens")) {
      remote.tokens.push(body);
      return Response.json({ token: "test-scoped-installation-token" });
    }
    if (method !== "GET") remote.writes.push({ path: u.pathname, body });
    if (u.pathname.endsWith("/contents/.github/workflows/traceyard.yml")) {
      if (method === "PUT") {
        remote.file = true;
        return Response.json({ commit: { sha: remote.head } });
      }
      const ref = u.searchParams.get("ref");
      if (ref === "main" || ref === remote.baseSha) {
        const content = remote.merged ? workflow : remote.previousWorkflow;
        return content === null
          ? new Response(null, { status: 404 })
          : Response.json({ content: btoa(content), sha: "c".repeat(40) });
      }
      if (!remote.file) return new Response(null, { status: 404 });
      return Response.json({
        content: btoa(workflow + (remote.tamper ? "# changed" : "")),
        sha: "c".repeat(40),
      });
    }
    if (u.pathname.includes("/git/ref/heads/"))
      return remote.exists
        ? Response.json({ object: { sha: remote.head } })
        : new Response(null, { status: 404 });
    if (u.pathname.endsWith("/commits/main")) return Response.json({ sha: remote.baseSha });
    if (u.pathname.includes("/compare/"))
      return Response.json({
        files: [
          {
            filename: remote.extraFile ? "unrelated.ts" : ".github/workflows/traceyard.yml",
            status: "added",
          },
        ],
      });
    if (u.pathname.endsWith("/git/refs")) {
      remote.exists = true;
      remote.branch = String(body.ref).replace("refs/heads/", "");
      return Response.json({ ref: body.ref });
    }
    if (u.pathname.endsWith("/pulls/4/files"))
      return Response.json([{ filename: ".github/workflows/traceyard.yml", status: "added" }]);
    if (u.pathname.endsWith("/pulls/4")) return Response.json(pull());
    if (u.pathname.endsWith("/pulls")) {
      if (method === "POST") {
        remote.pr = true;
        return Response.json(pull());
      }
      return Response.json(remote.pr ? [pull()] : []);
    }
    if (u.pathname.endsWith("/dispatches")) {
      if (remote.uncertain) throw Error("Response lost after GitHub accepted request");
      return new Response(null, { status: 204 });
    }
    if (u.pathname.endsWith("/actions/workflows/traceyard.yml/runs"))
      return Response.json({ workflow_runs: remote.runs });
    throw Error("Unexpected GitHub call: " + u.pathname);
  };
  const auth = await createUserSession(env.DB, user.id, new Request(ORIGIN));
  const cookie = (await createSession()).cookie + "; ty_auth_session=" + auth.token;
  const app = createApp({ githubFetch: fetcher });
  const call = (suffix: string, method = "GET", body?: unknown, otherCookie?: string) =>
    app.fetch(
      new Request(ORIGIN + `/api/projects/${project}/` + suffix, {
        method,
        headers: {
          cookie: otherCookie ?? cookie,
          origin: ORIGIN,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      configured,
    );
  const prepare = async () => {
    const setup = await prepareGitHubChecks(configured, project, fetcher);
    return setup.state === "SETUP_REQUIRED"
      ? prepareGitHubChecks(configured, project, fetcher, setup.previewKey)
      : setup;
  };
  const enable = async () => {
    await prepare();
    remote.merged = true;
    await prepareGitHubChecks(configured, project, fetcher);
  };
  const run = (id: string) => dispatchGitHubChecks(configured, project, id, fetcher);
  const manifest = async (requestId: string, runId = "1234") => {
    const encode = (v: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(v)));
    const input =
      encode({ alg: "RS256", kid: "ci-fixture" }) +
      "." +
      encode({
        iss: "https://token.actions.githubusercontent.com",
        aud: configured.PUBLIC_APP_ORIGIN,
        nbf: Math.floor(Date.now() / 1000) - 10,
        exp: Math.floor(Date.now() / 1000) + 300,
        runner_environment: "github-hosted",
        event_name: "workflow_dispatch",
        repository_id: "89",
        repository_owner_id: "981",
        ref: "refs/heads/main",
        workflow_ref: "ci-owner/app/.github/workflows/traceyard.yml@refs/heads/main",
        sha: "a".repeat(40),
        run_id: runId,
        run_attempt: "1",
      });
    const signature = base64UrlEncode(
      new Uint8Array(
        await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          key.privateKey,
          new TextEncoder().encode(input),
        ),
      ),
    );
    return app.fetch(
      new Request(ORIGIN + "/api/v1/repository/configuration?request=" + requestId, {
        headers: { Authorization: "Bearer " + input + "." + signature },
      }),
      configured,
    );
  };
  return {
    configured,
    project,
    remote,
    workflow,
    fetcher,
    call,
    prepare,
    enable,
    run,
    manifest,
  };
}

describe("GitHub check setup", () => {
  it("previews the current and proposed workflow before creating a pull request", async () => {
    const f = await fixture();
    f.remote.previousWorkflow = "name: Previous runner\n";
    const preview = await readSuccess<{ previewKey: string }>(await f.call("repository/setup"));
    expect(preview).toMatchObject({
      state: "SETUP_REQUIRED",
      previousWorkflow: f.remote.previousWorkflow,
      workflow: f.workflow,
      defaultBranch: "main",
    });
    expect(f.remote.writes).toHaveLength(0);
    expect((await f.call("repository/setup", "POST", {})).status).toBe(400);
    expect((await f.call("repository/analyze", "POST", { requestId: "first" })).status).toBe(409);
    const setup = await readSuccess(
      await f.call("repository/setup", "POST", { previewKey: preview.previewKey }),
    );
    expect(setup).toMatchObject({
      state: "AWAITING_MERGE",
      prUrl: "https://github.com/ci-owner/app/pull/4",
    });
    expect(f.remote.writes.map((w) => w.path)).toEqual([
      "/repos/ci-owner/app/git/refs",
      "/repos/ci-owner/app/contents/.github/workflows/traceyard.yml",
      "/repos/ci-owner/app/pulls",
    ]);
    expect(f.remote.tokens[0]).toEqual({
      repository_ids: [89],
      permissions: {
        contents: "write",
        pull_requests: "write",
        workflows: "write",
        actions: "write",
      },
    });
    expect(f.workflow).toContain("id-token: write");
    expect(f.workflow).not.toContain("TRACEYARD_KEY");
    expect(f.workflow).not.toContain("push:");
    await f.prepare();
    expect(f.remote.writes).toHaveLength(3);
  });
  it("requires a fresh preview after the default branch moves", async () => {
    const f = await fixture();
    const preview = await readSuccess<{ previewKey: string }>(await f.call("repository/setup"));
    f.remote.baseSha = "d".repeat(40);
    expect(
      (await f.call("repository/setup", "POST", { previewKey: preview.previewKey })).status,
    ).toBe(409);
    expect(f.remote.writes).toHaveLength(0);
  });
  it("rejects extra changed files before opening the PR", async () => {
    const f = await fixture();
    f.remote.extraFile = true;
    await expect(f.prepare()).rejects.toMatchObject({ code: "CI_SETUP_CHANGED" });
    expect(f.remote.writes.some((w) => w.path.endsWith("/pulls"))).toBe(false);
  });
  it("leaves merging to GitHub and waits for the actual default-branch file", async () => {
    const f = await fixture();
    await f.prepare();
    expect(
      (await f.call("repository/enable", "POST", { prNumber: 4, headSha: f.remote.head })).status,
    ).toBe(409);
    expect(f.remote.writes.some((w) => w.path.includes("/merge"))).toBe(false);
    await expect(f.run("too-early")).rejects.toMatchObject({ code: "CI_SETUP_REQUIRED" });
    f.remote.merged = true;
    expect(await prepareGitHubChecks(f.configured, f.project, f.fetcher)).toEqual({
      state: "READY",
    });
    expect((await f.run("first-run")).state).toBe("QUEUED");
  });
  it.each(["head", "extraFile", "tamper"] as const)(
    "rejects a changed %s on an existing setup PR",
    async (mode) => {
      const f = await fixture();
      await f.prepare();
      if (mode === "head") f.remote.head = "d".repeat(40);
      else f.remote[mode] = true;
      await expect(f.prepare()).rejects.toMatchObject({ code: "CI_SETUP_CHANGED" });
    },
  );
  it("dispatches a frozen manifest once and serializes competing requests", async () => {
    const f = await fixture();
    await f.enable();
    const first = await f.run("same");
    expect((await f.run("same")).id).toBe(first.id);
    const snapshot = await env.DB.prepare(
      "SELECT snapshot_json FROM repository_check_requests WHERE id=?",
    )
      .bind(first.id)
      .first<{ snapshot_json: string }>();
    expect(JSON.parse(snapshot!.snapshot_json)).toMatchObject({ cases: [] });
    expect(f.remote.writes.filter((w) => w.path.endsWith("dispatches"))).toHaveLength(1);
    await expect(f.run("different")).rejects.toMatchObject({ code: "CHECK_ALREADY_RUNNING" });
    await bindGitHubDispatch(f.configured, f.project, first.id, "1234-1", "a".repeat(40));
    expect(
      await env.DB.prepare("SELECT source FROM repository_jobs WHERE id='1234-1'").first(),
    ).toEqual({ source: "github" });
    expect(
      await env.DB.prepare("SELECT id FROM repository_jobs WHERE id=?").bind(first.id).first(),
    ).toBeNull();
  });
  it("uses GitHub OIDC to bind a manifest to exactly one runner without a customer key", async () => {
    const f = await fixture();
    await f.enable();
    const check = await f.run("oidc");
    expect(await readSuccess(await f.manifest(check.id))).toMatchObject({ cases: [] });
    expect(
      await env.DB.prepare("SELECT runner_id FROM github_check_dispatches WHERE id=?")
        .bind(check.id)
        .first(),
    ).toEqual({ runner_id: "1234-1" });
    expect((await f.manifest(check.id, "5678")).status).toBe(400);
  });
  it("rejects cancelled and expired manifests before application scripts can start", async () => {
    const f = await fixture();
    await f.enable();
    const check = await f.run("cancel-manifest");
    await f.call(`checks/${check.id}/cancel`, "POST");
    expect((await f.manifest(check.id)).status).toBe(409);
    await env.DB.prepare("UPDATE repository_check_requests SET created_at=? WHERE id=?")
      .bind(new Date(Date.now() - 31 * 60000).toISOString(), check.id)
      .run();
    expect((await f.manifest(check.id)).status).toBe(404);
  });
  it("makes concurrent different Run requests produce only one workflow dispatch", async () => {
    const f = await fixture();
    await f.enable();
    const outcomes = await Promise.allSettled([f.run("a"), f.run("b")]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(f.remote.writes.filter((w) => w.path.endsWith("dispatches"))).toHaveLength(1);
  });
  it("preserves an uncertain dispatch and finds its existing runner without repeating execution", async () => {
    const f = await fixture();
    await f.enable();
    f.remote.uncertain = true;
    const check = await f.run("uncertain");
    expect(check.state).toBe("UNKNOWN");
    expect((await f.run("uncertain")).id).toBe(check.id);
    await env.DB.prepare("UPDATE github_check_dispatches SET updated_at=? WHERE id=?")
      .bind(new Date(Date.now() - 61000).toISOString(), check.id)
      .run();
    f.remote.runs = [
      {
        id: 1234,
        run_attempt: 1,
        display_title: `Traceyard ${check.id}`,
        head_sha: "a".repeat(40),
        head_branch: "main",
        path: ".github/workflows/traceyard.yml",
        repository: { id: 89 },
      },
    ];
    await syncGitHubDispatches(f.configured, f.project, f.fetcher);
    expect(
      await env.DB.prepare("SELECT state,runner_id FROM github_check_dispatches WHERE id=?")
        .bind(check.id)
        .first(),
    ).toEqual({ state: "BOUND", runner_id: "1234-1" });
    expect(f.remote.writes.filter((w) => w.path.endsWith("dispatches"))).toHaveLength(1);
  });
  it("cancels a pending request before the application can bind and start", async () => {
    const f = await fixture();
    await f.enable();
    const check = await f.run("cancel");
    expect((await f.call(`checks/${check.id}/cancel`, "POST")).status).toBe(202);
    await expect(
      bindGitHubDispatch(f.configured, f.project, check.id, "1234-1", "a".repeat(40)),
    ).rejects.toMatchObject({ code: "CHECK_CANCELLED" });
    expect(
      await env.DB.prepare("SELECT status FROM repository_jobs WHERE id=?").bind(check.id).first(),
    ).toEqual({ status: "CANCELLED" });
  });
  it("marks a missing runner unconfirmed after ten minutes while keeping source available", async () => {
    const f = await fixture();
    await f.enable();
    const check = await f.run("lost");
    await env.DB.prepare("UPDATE github_check_dispatches SET created_at=?,updated_at=? WHERE id=?")
      .bind(
        new Date(Date.now() - 11 * 60000).toISOString(),
        new Date(Date.now() - 61000).toISOString(),
        check.id,
      )
      .run();
    await syncGitHubDispatches(f.configured, f.project, f.fetcher);
    expect(
      await env.DB.prepare("SELECT status FROM repository_jobs WHERE id=?").bind(check.id).first(),
    ).toEqual({ status: "STALE" });
    expect(
      await env.DB.prepare("SELECT status FROM project_repositories WHERE project_id=?")
        .bind(f.project)
        .first(),
    ).toEqual({ status: "DISCOVERED" });
    expect(f.remote.writes.filter((w) => w.path.endsWith("dispatches"))).toHaveLength(1);
  });
});
