import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../worker/api/app";
import {
  requestManagedCheck,
  finishManagedCheck,
  reapManagedChecks,
} from "../../worker/repositories/managed";
import { createSession, ORIGIN, readSuccess } from "./helpers";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import { runScheduledJobs } from "../../worker/jobs/scheduled";
import { scanRepository } from "../../worker/repositories/scan";
import { runManagedCheck, type ManagedExecution } from "../../worker/repositories/managed-runner";

async function fixture() {
  const user = await getOrCreateGitHubIdentity(env.DB, {
    id: 980,
    login: "managed-owner",
    name: "Owner",
    avatarUrl: null,
  });
  const auth = await createUserSession(env.DB, user.id, new Request(ORIGIN));
  const project = (await getDefaultProjectId(env.DB, user.id))!;
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO github_installations(id,account_id,account_login,updated_at) VALUES(8,'980','managed-owner',?)",
  )
    .bind(at)
    .run();
  const source = JSON.stringify({
    operations: [
      {
        id: "health",
        name: "GET /health",
        kind: "http",
        file: "api.ts",
        line: 1,
        calls: [],
        evidence: "source",
      },
    ],
    filesScanned: 1,
    warnings: [],
  });
  await env.DB.prepare(
    "INSERT INTO project_repositories(project_id,repository_id,installation_id,full_name,default_branch,status,commit_sha,scan_json,updated_at) VALUES(?,88,8,'managed-owner/app','main','DISCOVERED',?,?,?)",
  )
    .bind(project, "a".repeat(40), source, at)
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
  const queued: ManagedExecution[] = [];
  const configured: Env = {
    ...env,
    PUBLIC_APP_ORIGIN: "https://traceyard.example",
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "traceyard",
    GITHUB_APP_WEBHOOK_SECRET: "fixture-only",
    GITHUB_APP_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\n" +
      btoa(
        String.fromCharCode(
          ...new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey)),
        ),
      ) +
      "\n-----END PRIVATE KEY-----",
    MANAGED_REPOSITORY_RUNNERS: {
      getByName: () => ({
        enqueue: async (input: ManagedExecution) => {
          queued.push(input);
        },
        cancel: async () => {},
      }),
    } as unknown as Env["MANAGED_REPOSITORY_RUNNERS"],
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/access_tokens"))
      return Response.json({ token: "fixture-installation-token" });
    if (init?.method && init.method !== "GET")
      throw Error("Customer repository mutation is forbidden in this test");
    if (url.endsWith("/commits/main")) return Response.json({ sha: "a".repeat(40) });
    throw Error("Unexpected external request");
  };
  const app = createApp({ githubFetch: fetcher });
  const cookie = (await createSession()).cookie + "; ty_auth_session=" + auth.token;
  const call = (path: string, method = "GET", body?: unknown, token?: string) =>
    app.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: {
          cookie,
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      configured,
    );
  return { configured, fetcher, queued, project, call, source };
}

function controller(configured: Env, input: ManagedExecution, started = false) {
  const values = new Map<string, unknown>([["input", input]]);
  if (started) values.set("started", true);
  const commands: { argv: string[]; env: Record<string, string> }[] = [];
  const container = {
    running: false,
    images: { runner: "fixture-image" },
    start: vi.fn(() => {
      container.running = true;
    }),
    destroy: vi.fn(async () => {
      container.running = false;
    }),
    exec: vi.fn(async (argv: string[], options: { env: Record<string, string> }) => {
      commands.push({ argv, env: options.env });
      return { exitCode: Promise.resolve(0) };
    }),
  };
  const alarm = vi.fn(async () => {});
  const state = {
    container,
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      setAlarm: alarm,
      deleteAll: async () => {
        values.clear();
      },
    },
  } as unknown as DurableObjectState;
  return {
    runner: { alarm: () => runManagedCheck(state, configured) },
    container,
    commands,
    alarm,
    values,
  };
}

describe("Traceyard-managed repository checks", () => {
  it("confines GitHub credentials to checkout and destroys the workspace after an unverified exit", async () => {
    const f = await fixture(),
      check = await requestManagedCheck(f.configured, f.project, "controller", f.fetcher);
    const c = controller(f.configured, f.queued[0]!);
    let revoked = false;
    const external = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/access_tokens")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          repository_ids: [88],
          permissions: { contents: "read" },
        });
        return Response.json({ token: "fixture-only-read-token" });
      }
      if (String(input).endsWith("/installation/token") && init?.method === "DELETE") {
        revoked = true;
        return new Response(null, { status: 204 });
      }
      throw Error("Unexpected network request");
    });
    c.container.exec.mockImplementation(
      async (argv: string[], options: { env: Record<string, string> }) => {
        if (argv[0] === "node") expect(revoked).toBe(true);
        c.commands.push({ argv, env: options.env });
        return { exitCode: Promise.resolve(0) };
      },
    );
    try {
      await c.runner.alarm();
    } finally {
      external.mockRestore();
    }
    expect(c.container.start).toHaveBeenCalledTimes(1);
    expect(c.container.destroy).toHaveBeenCalledTimes(1);
    const gitFetch = c.commands.find((cmd) => cmd.argv.includes("fetch"));
    expect(gitFetch?.env.GIT_CONFIG_VALUE_0).toContain("Authorization: Basic");
    const app = c.commands.find((cmd) => cmd.argv[0] === "node");
    expect(app?.env.TRACEYARD_RUN_TOKEN).toBe(f.queued[0]!.token);
    expect(JSON.stringify(app)).not.toContain("fixture-only-read-token");
    expect(app?.env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(
      c.commands.some((cmd) => cmd.argv.join(" ") === "rm -rf /workspace/application/.git"),
    ).toBe(true);
    expect(c.values.size).toBe(0);
    const job = await env.DB.prepare("SELECT status,events_json FROM repository_jobs WHERE id=?")
      .bind(check.id)
      .first<{ status: string; events_json: string }>();
    expect(job?.status).toBe("FAILED");
    expect(job?.events_json).toContain("without a complete test report");
  });
  it("never re-executes an interrupted controller turn", async () => {
    const f = await fixture(),
      check = await requestManagedCheck(f.configured, f.project, "interrupted", f.fetcher);
    await env.DB.prepare("UPDATE managed_repository_checks SET state='RUNNING' WHERE id=?")
      .bind(check.id)
      .run();
    await env.DB.prepare("UPDATE repository_jobs SET status='RUNNING' WHERE id=?")
      .bind(check.id)
      .run();
    const c = controller(f.configured, f.queued[0]!, true);
    await c.runner.alarm();
    expect(c.container.start).not.toHaveBeenCalled();
    expect(c.commands).toHaveLength(0);
    const job = await env.DB.prepare("SELECT status,events_json FROM repository_jobs WHERE id=?")
      .bind(check.id)
      .first<{ status: string; events_json: string }>();
    expect(job?.status).toBe("FAILED");
    expect(job?.events_json).toContain("not automatically repeated");
  });
  it("waits without starting a VM when global runner capacity is full", async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) {
      const busy = await requestManagedCheck(f.configured, f.project, `push:busy-${i}`, f.fetcher);
      await env.DB.prepare("UPDATE managed_repository_checks SET state='RUNNING' WHERE id=?")
        .bind(busy.id)
        .run();
      await env.DB.prepare("UPDATE repository_jobs SET status='RUNNING' WHERE id=?")
        .bind(busy.id)
        .run();
    }
    const queued = await requestManagedCheck(f.configured, f.project, "push:waiting", f.fetcher);
    const c = controller(f.configured, f.queued[2]!);
    await c.runner.alarm();
    expect(c.container.start).not.toHaveBeenCalled();
    expect(c.alarm).toHaveBeenCalledTimes(1);
    expect(
      (
        await env.DB.prepare("SELECT state FROM managed_repository_checks WHERE id=?")
          .bind(queued.id)
          .first<{ state: string }>()
      )?.state,
    ).toBe("QUEUED");
  });
  it("queues one frozen check for concurrent identical requests without a setup PR", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([
      requestManagedCheck(f.configured, f.project, "request-one", f.fetcher),
      requestManagedCheck(f.configured, f.project, "request-one", f.fetcher),
    ]);
    expect(a.id).toBe(b.id);
    expect(f.queued).toHaveLength(1);
    const replay = await requestManagedCheck(f.configured, f.project, "request-one", f.fetcher);
    expect(replay.id).toBe(a.id);
    expect(f.queued).toHaveLength(1);
    const row = await env.DB.prepare(
      "SELECT token_hash,snapshot_json FROM managed_repository_checks WHERE id=?",
    )
      .bind(a.id)
      .first<{ token_hash: string; snapshot_json: string }>();
    expect(row?.token_hash).not.toBe(f.queued[0]?.token);
    expect(row?.snapshot_json).not.toContain("fixture-installation-token");
    expect(JSON.parse(row!.snapshot_json).sha).toBe("a".repeat(40));
    expect(
      await env.DB.prepare(
        "SELECT setup_pr_url,runner_enabled FROM project_repositories WHERE project_id=?",
      )
        .bind(f.project)
        .first(),
    ).toEqual({ setup_pr_url: null, runner_enabled: 0 });
  });
  it("rejects reuse of a request ID for a different test without starting extra work", async () => {
    const f = await fixture();
    await requestManagedCheck(f.configured, f.project, "same-request", f.fetcher);
    await expect(
      requestManagedCheck(
        f.configured,
        f.project,
        "same-request",
        f.fetcher,
        "different-test-request",
      ),
    ).rejects.toThrow("another check");
    expect(f.queued).toHaveLength(1);
  });
  it("rescans on a signed push without discarding the last usable source index", async () => {
    const f = await fixture(),
      tasks: { params: { commitSha?: string } }[] = [];
    f.configured.REPOSITORY_DISCOVERY = {
      create: async (task: { params: { commitSha?: string } }) => {
        tasks.push(task);
        return {};
      },
    } as unknown as Env["REPOSITORY_DISCOVERY"];
    const send = async (body: unknown) => {
      const raw = JSON.stringify(body),
        key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode("fixture-only"),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
      const sig = Array.from(
        new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw))),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      return createApp({ githubFetch: f.fetcher }).fetch(
        new Request(ORIGIN + "/api/github/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-github-event": "push",
            "x-hub-signature-256": "sha256=" + sig,
          },
          body: raw,
        }),
        f.configured,
      );
    };
    const body = { repository: { id: 88 }, ref: "refs/heads/main", after: "a".repeat(40) };
    expect((await send(body)).status).toBe(200);
    expect((await send(body)).status).toBe(200);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.params.commitSha).toBe("a".repeat(40));
    const catalog = await readSuccess<{ operations: { name: string }[] }>(
      await f.call(`/api/projects/${f.project}/catalog`),
    );
    expect(catalog.operations[0]?.name).toBe("GET /health");
    expect((await send({ ...body, after: "b".repeat(40) })).status).toBe(200);
    expect(tasks).toHaveLength(1);
  });
  it("authenticates only the assigned active run and freezes its configuration", async () => {
    const f = await fixture(),
      check = await requestManagedCheck(f.configured, f.project, "request-token", f.fetcher),
      token = f.queued[0]!.token;
    await env.DB.prepare("UPDATE managed_repository_checks SET state='RUNNING' WHERE id=?")
      .bind(check.id)
      .run();
    await env.DB.prepare("UPDATE repository_jobs SET status='RUNNING' WHERE id=?")
      .bind(check.id)
      .run();
    await f.call(`/api/projects/${f.project}/runner-config`, "PUT", {
      directory: "changed",
      startScript: "start",
      port: 3001,
    });
    const config = await readSuccess<{ config: { directory: string } }>(
      await f.call("/api/v1/repository/configuration", "GET", undefined, token),
    );
    expect(config.config.directory).toBe(".");
    const wrong = await f.call(
      "/api/v1/repository-runs",
      "POST",
      {
        id: "managed_" + "b".repeat(32),
        sha: "a".repeat(40),
        phase: "test",
        status: "RUNNING",
        message: "Testing",
      },
      token,
    );
    expect(wrong.status).toBe(403);
    await finishManagedCheck(f.configured, check.id, "CANCELLED", "Cancelled");
    expect((await f.call("/api/v1/repository/configuration", "GET", undefined, token)).status).toBe(
      401,
    );
  });
  it("retains source operations when execution fails and when a rescan fails", async () => {
    const f = await fixture(),
      check = await requestManagedCheck(f.configured, f.project, "request-fail", f.fetcher);
    await finishManagedCheck(f.configured, check.id, "FAILED", "Install failed");
    expect(
      (
        await env.DB.prepare("SELECT scan_json,status FROM project_repositories WHERE project_id=?")
          .bind(f.project)
          .first<{ scan_json: string; status: string }>()
      )?.scan_json,
    ).toBe(f.source);
    await expect(
      scanRepository(
        f.configured,
        {
          project_id: f.project,
          installation_id: 8,
          full_name: "managed-owner/app",
          default_branch: "main",
        },
        async () => new Response(null, { status: 503 }),
      ),
    ).rejects.toThrow();
    const catalog = await readSuccess<{
      operations: { name: string }[];
      repository: { status: string };
    }>(await f.call(`/api/projects/${f.project}/catalog`));
    expect(catalog.operations.some((o) => o.name === "GET /health")).toBe(true);
    expect(catalog.repository.status).toBe("FAILED");
  });
  it("replays a saved HTTP request after a lost response without launching it twice", async () => {
    const f = await fixture();
    const catalog = await readSuccess<{ operations: { key: string }[] }>(
      await f.call(`/api/projects/${f.project}/catalog`),
    );
    const key = catalog.operations[0]!.key;
    const saved = await readSuccess<{ id: string }>(
      await f.call(`/api/projects/${f.project}/operations/${key}/cases`, "POST", {
        name: "Health",
        method: "GET",
        path: "/health",
      }),
    );
    await f.call(`/api/projects/${f.project}/runner-config`, "PUT", {
      directory: ".",
      startScript: "start",
      port: 3000,
    });
    const path = `/api/projects/${f.project}/operations/${key}/test`;
    const [a, b] = await Promise.all([
      f.call(path, "POST", { caseId: saved.id, requestId: "same-click" }),
      f.call(path, "POST", { caseId: saved.id, requestId: "same-click" }),
    ]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const first = await readSuccess<{ id: string }>(a),
      second = await readSuccess<{ id: string }>(b);
    expect(first.id).toBe(second.id);
    expect(f.queued).toHaveLength(1);
  });
  it("expires an uncertain check without replaying it or hiding source", async () => {
    const f = await fixture(),
      check = await requestManagedCheck(f.configured, f.project, "expire", f.fetcher);
    await env.DB.prepare(
      "UPDATE managed_repository_checks SET state='RUNNING',expires_at=? WHERE id=?",
    )
      .bind(new Date(Date.now() - 1000).toISOString(), check.id)
      .run();
    await env.DB.prepare("UPDATE repository_jobs SET status='RUNNING' WHERE id=?")
      .bind(check.id)
      .run();
    await reapManagedChecks(f.configured);
    expect(
      (
        await env.DB.prepare("SELECT status,events_json FROM repository_jobs WHERE id=?")
          .bind(check.id)
          .first<{ status: string; events_json: string }>()
      )?.status,
    ).toBe("FAILED");
    expect(f.queued).toHaveLength(1);
    expect(
      (await f.call("/api/v1/repository/configuration", "GET", undefined, f.queued[0]!.token))
        .status,
    ).toBe(401);
    const catalog = await readSuccess<{ operations: unknown[] }>(
      await f.call(`/api/projects/${f.project}/catalog`),
    );
    expect(catalog.operations).toHaveLength(1);
    const old = new Date(Date.now() - 31 * 24 * 3600000).toISOString();
    await env.DB.prepare("UPDATE managed_repository_checks SET created_at=? WHERE id=?")
      .bind(old, check.id)
      .run();
    await env.DB.prepare("UPDATE repository_jobs SET updated_at=? WHERE id=?")
      .bind(old, check.id)
      .run();
    await runScheduledJobs(f.configured);
    expect(
      await env.DB.prepare("SELECT id FROM managed_repository_checks WHERE id=?")
        .bind(check.id)
        .first(),
    ).toBeNull();
    expect((await f.call(`/api/projects/${f.project}/catalog`)).status).toBe(200);
  });
  it("does not let runtime discovery clear a failed newer source scan", async () => {
    const f = await fixture(),
      check = await requestManagedCheck(f.configured, f.project, "older-runtime", f.fetcher);
    await env.DB.prepare("UPDATE managed_repository_checks SET state='RUNNING' WHERE id=?")
      .bind(check.id)
      .run();
    await env.DB.prepare("UPDATE repository_jobs SET status='RUNNING' WHERE id=?")
      .bind(check.id)
      .run();
    await env.DB.prepare(
      "UPDATE project_repositories SET status='FAILED',last_error='New scan could not finish' WHERE project_id=?",
    )
      .bind(f.project)
      .run();
    const report = await f.call(
      "/api/v1/repository-runs",
      "POST",
      {
        id: check.id,
        sha: "a".repeat(40),
        phase: "discovery",
        status: "SUCCEEDED",
        message: "Read checkout",
        operations: [],
        filesScanned: 1,
      },
      f.queued[0]!.token,
    );
    expect(report.status).toBe(200);
    const repo = await env.DB.prepare(
      "SELECT status,scan_json FROM project_repositories WHERE project_id=?",
    )
      .bind(f.project)
      .first<{ status: string; scan_json: string }>();
    expect(repo?.status).toBe("FAILED");
    expect(repo?.scan_json).toBe(f.source);
  });
  it("bounds accepted checks per project while leaving source readable", async () => {
    const f = await fixture();
    for (let n = 0; n < 6; n++) {
      const check = await requestManagedCheck(f.configured, f.project, `quota-${n}`, f.fetcher);
      await finishManagedCheck(f.configured, check.id, "FAILED", "Test ended");
    }
    await expect(
      requestManagedCheck(f.configured, f.project, "quota-7", f.fetcher),
    ).rejects.toThrow("hourly check limit");
    expect(f.queued).toHaveLength(6);
    expect((await f.call(`/api/projects/${f.project}/catalog`)).status).toBe(200);
  });
  it("offers in-app GitHub setup when managed execution infrastructure is absent", async () => {
    const f = await fixture();
    delete f.configured.MANAGED_REPOSITORY_RUNNERS;
    expect(
      (
        await f.call(`/api/projects/${f.project}/repository/analyze`, "POST", {
          requestId: "run-one",
        })
      ).status,
    ).toBe(409);
    const catalog = await readSuccess<{
      executionAvailable: boolean;
      executionProvider: string;
      operations: unknown[];
    }>(await f.call(`/api/projects/${f.project}/catalog`));
    expect(catalog.executionAvailable).toBe(true);
    expect(catalog.executionProvider).toBe("github");
    expect(catalog.operations.length).toBe(1);
  });
  it("a failed request can be retried explicitly without reusing or replaying its execution", async () => {
    const f = await fixture(),
      a = await requestManagedCheck(f.configured, f.project, "attempt-one", f.fetcher);
    await finishManagedCheck(f.configured, a.id, "FAILED", "Test failed");
    expect((await requestManagedCheck(f.configured, f.project, "attempt-one", f.fetcher)).id).toBe(
      a.id,
    );
    const b = await requestManagedCheck(f.configured, f.project, "attempt-two", f.fetcher);
    expect(b.id).not.toBe(a.id);
    expect(f.queued).toHaveLength(2);
  });
});
