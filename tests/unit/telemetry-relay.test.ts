import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RELAY_MAX_BODY_BYTES,
  startTelemetryRelay,
  untrustedEnvironment,
} from "../../agent/telemetry-relay.mjs";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function collector() {
  const received: { path: string; authorization?: string; body: string }[] = [];
  let status = 200;
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ path: req.url!, authorization: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET")
      res.end(JSON.stringify({ data: { config: { directory: ".", port: 3000 }, cases: [] } }));
    else res.writeHead(status).end(JSON.stringify({ data: { received: true } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No collector");
  cleanups.push(
    () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  return {
    origin: "http://127.0.0.1:" + address.port,
    received,
    fail: () => (status = 500),
  };
}

async function relayTo(target: string) {
  const relay = await startTelemetryRelay({ target, credential: async () => "tyr_secret" });
  cleanups.push(relay.close);
  return relay;
}

const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

describe("telemetry relay", () => {
  it("forwards trace batches with the trusted credential and drops caller headers", async () => {
    const upstream = await collector();
    const relay = await relayTo(upstream.origin + "/api/v1/otlp/v1/traces");
    expect(relay.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/traces$/);
    const response = await post(relay.endpoint, '{"resourceSpans":[]}', {
      authorization: "Bearer forged",
    });
    expect(response.status).toBe(200);
    expect(upstream.received).toEqual([
      {
        path: "/api/v1/otlp/v1/traces",
        authorization: "Bearer tyr_secret",
        body: '{"resourceSpans":[]}',
      },
    ]);
  });

  it.each([
    ["another path", "/api/v1/repository-runs", "POST", "application/json", "{}", 404],
    ["a GET request", "/v1/traces", "GET", "application/json", undefined, 404],
    ["non-JSON content", "/v1/traces", "POST", "application/x-protobuf", "x", 415],
    ["invalid JSON", "/v1/traces", "POST", "application/json", "{", 400],
    [
      "an oversized batch",
      "/v1/traces",
      "POST",
      "application/json",
      JSON.stringify({ pad: "x".repeat(RELAY_MAX_BODY_BYTES) }),
      413,
    ],
  ])("refuses %s without contacting Traceyard", async (_name, path, method, type, body, code) => {
    const upstream = await collector();
    const relay = await relayTo(upstream.origin + "/api/v1/otlp/v1/traces");
    const response = await fetch(relay.origin + path, {
      method,
      headers: { "content-type": type },
      body,
    });
    expect(response.status).toBe(code);
    expect(upstream.received).toHaveLength(0);
  });

  it("reports an upstream rejection without exposing the credential", async () => {
    const upstream = await collector();
    upstream.fail();
    const relay = await relayTo(upstream.origin + "/api/v1/otlp/v1/traces");
    const response = await post(relay.endpoint, "{}");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("tyr_secret");
  });

  it("rejects a target carrying credentials", async () => {
    await expect(
      startTelemetryRelay({ target: "https://user:pw@example.test/x", credential: async () => "" }),
    ).rejects.toThrow(/plain URL/);
  });
});

describe("untrusted environment", () => {
  it("removes credentials and control-plane values in any letter case", () => {
    const env = untrustedEnvironment({
      PATH: "/bin",
      CI: "true",
      TRACEYARD_KEY: "tyk_x",
      TRACEYARD_RUN_TOKEN: "tyr_x",
      traceyard_github_fetch_token: "ghs_x",
      GITHUB_TOKEN: "ghs_y",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc",
      ACTIONS_RUNTIME_TOKEN: "rt",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20x",
      NODE_OPTIONS: "--require evil.cjs",
    });
    expect(env).toEqual({ PATH: "/bin", CI: "true" });
  });
});

describe("repository .env.traceyard", { timeout: 60000 }, () => {
  async function runAgent(mode: "local" | "managed", envFile: string, origin?: string) {
    const root = await mkdtemp(join(tmpdir(), "traceyard-envfile-"));
    cleanups.push(() =>
      rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {
        /* Windows file lock on temporary fixture directory */
      }),
    );
    const dump = join(root, "test-env.json");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "envfile-fixture",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test test.mjs" },
      }),
    );
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        name: "envfile-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "envfile-fixture", version: "1.0.0" } },
      }),
    );
    await writeFile(
      join(root, "test.mjs"),
      `import {test} from 'node:test';import {writeFileSync} from 'node:fs';test('env',()=>writeFileSync(${JSON.stringify(dump)},JSON.stringify(process.env)));`,
    );
    await writeFile(join(root, ".env.traceyard"), envFile);
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: "false" };
    delete env.TRACEYARD_ORIGIN;
    delete env.TRACEYARD_KEY;
    if (origin) env.TRACEYARD_ORIGIN = origin;
    if (mode === "managed")
      Object.assign(env, {
        TRACEYARD_RUN_TOKEN: "tyr_" + "A".repeat(43),
        TRACEYARD_MANAGED_RUN_ID: "managed_" + "a".repeat(32),
        TRACEYARD_COMMIT_SHA: "a".repeat(40),
      });
    const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
      const child = spawn(process.execPath, [resolve("agent/cli.mjs"), "run", root], { env });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      child.on("error", reject);
      child.on("exit", (code) => done({ code, output }));
    });
    const testEnv = await readFile(dump, "utf8").then(JSON.parse, () => null);
    return { ...result, testEnv };
  }

  it("is ignored by hosted runs, so repository content cannot redirect the agent", async () => {
    const upstream = await collector();
    const run = await runAgent("managed", `TRACEYARD_ORIGIN=${upstream.origin}\n`);
    expect(run.code).toBe(1);
    expect(run.output).toContain("Set TRACEYARD_ORIGIN");
    expect(upstream.received).toHaveLength(0);
  });

  it("supplies only connection settings to a local run", async () => {
    const upstream = await collector();
    const run = await runAgent(
      "local",
      `TRACEYARD_ORIGIN=${upstream.origin}\nTRACEYARD_KEY=tyk_${"B".repeat(43)}\nTRACEYARD_PROBE=from-repository\n`,
    );
    expect(run.code, run.output).toBe(0);
    expect(upstream.received[0]?.authorization).toBe("Bearer tyk_" + "B".repeat(43));
    expect(run.testEnv).not.toBeNull();
    expect(run.testEnv.TRACEYARD_PROBE).toBeUndefined();
    expect(JSON.stringify(run.testEnv)).not.toContain("tyk_");
  });

  it("does not override settings already in the environment", async () => {
    const upstream = await collector();
    const run = await runAgent(
      "local",
      `TRACEYARD_ORIGIN=http://127.0.0.1:9\nTRACEYARD_KEY=tyk_${"B".repeat(43)}\n`,
      upstream.origin,
    );
    expect(run.code, run.output).toBe(0);
    expect(upstream.received.length).toBeGreaterThan(0);
  });
});
