import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { convertOtlp } from "../../worker/repositories/otlp";
import { spanBatchSchema } from "../../shared/contracts/traces";

it.each([
  ["SUCCEEDED", "local"],
  ["FAILED", "local"],
  ["SKIPPED", "local"],
  ["SUCCEEDED", "managed"],
  ["FAILED", "managed"],
  ["SUCCEEDED", "managed-workspace"],
  ["SUCCEEDED", "managed-focused-workspace"],
  ["SUCCEEDED", "vitest"],
  ["FAILED", "vitest"],
])(
  "runs real project checks and reports %s using the %s runner with actual spans",
  async (expectedStatus, mode) => {
    const root = await mkdtemp(join(tmpdir(), "traceyard-agent-"));
    const managed = mode.startsWith("managed");
    const focused = mode === "managed-focused-workspace";
    const workspace = focused || mode === "managed-workspace";
    const appRoot = workspace ? join(root, "apps", "api") : root;
    const selectedTest = "apps/api/tests/unit/target.test.ts";
    const investigationId = "inv_" + "a".repeat(32);
    await mkdir(appRoot, { recursive: true });
    const received: {
      path: string;
      body: unknown;
      authorization?: string;
      contentType?: string;
    }[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === "GET") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            data: {
              config: {
                directory: workspace && !focused ? "apps/api" : ".",
                startScript: "",
                port: 3000,
              },
              cases: [],
              ...(focused
                ? {
                    investigation: {
                      investigationId,
                      requestId: "req_" + "b".repeat(32),
                      question: "Run the selected workspace test",
                      testPath: selectedTest,
                      commit: null,
                      timeoutMs: 20000,
                    },
                  }
                : {}),
            },
          }),
        );
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      received.push({
        path: req.url!,
        body: JSON.parse(raw),
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { received: true } }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No collector address.");
    try {
      await writeFile(
        join(appRoot, "package.json"),
        JSON.stringify({
          name: "agent-fixture",
          version: "1.0.0",
          type: "module",
          scripts:
            expectedStatus === "SKIPPED"
              ? {}
              : {
                  test:
                    mode === "vitest"
                      ? `node ${JSON.stringify(resolve("node_modules/vitest/vitest.mjs"))} run --config vitest.config.mjs`
                      : "node --test test.mjs",
                },
        }),
      );
      await writeFile(
        join(root, "package-lock.json"),
        JSON.stringify({
          name: "agent-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "agent-fixture",
              version: "1.0.0",
              ...(workspace ? { workspaces: ["apps/api"] } : {}),
            },
            ...(workspace
              ? {
                  "apps/api": { name: "agent-fixture-api", version: "1.0.0" },
                  "node_modules/agent-fixture-api": { resolved: "apps/api", link: true },
                }
              : {}),
          },
        }),
      );
      if (workspace) {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ name: "agent-fixture", version: "1.0.0", workspaces: ["apps/api"] }),
        );
        const appPackage = {
          name: "agent-fixture-api",
          version: "1.0.0",
          type: "module",
          scripts: focused
            ? {
                "test:unit": `node ${JSON.stringify(resolve("node_modules/vitest/vitest.mjs"))} run`,
              }
            : { test: "node --test test.mjs" },
        };
        await writeFile(join(appRoot, "package.json"), JSON.stringify(appPackage));
      }
      await writeFile(
        join(appRoot, "server.ts"),
        "app.post('/interpret',async()=>generateReply());",
      );
      if (mode === "vitest")
        await writeFile(
          join(appRoot, "vitest.config.mjs"),
          "export default {test:{include:['test.mjs'],pool:'forks',fileParallelism:false}};",
        );
      await writeFile(
        join(appRoot, "test.mjs"),
        `import {test} from ${JSON.stringify(mode === "vitest" ? pathToFileURL(resolve("node_modules/vitest/dist/index.js")).href : "node:test")};import {createServer} from 'node:http';import {once} from 'node:events';test('application HTTP flow',async()=>{(await import('node:fs')).writeFileSync(${JSON.stringify(join(root, "test-env.json"))},JSON.stringify(process.env));const server=createServer((req,res)=>res.end('ok'));server.listen(0,'127.0.0.1');await once(server,'listening');const response=await fetch('http://127.0.0.1:'+server.address().port+'/interpret');await response.text();server.closeAllConnections();server.close();${mode === "vitest" ? "await new Promise(r=>setTimeout(r,700));" : ""}${expectedStatus === "FAILED" ? "throw new Error('supabaseUrl is required. private@example.test');" : ""}});`,
      );
      if (focused) {
        await mkdir(join(appRoot, "tests", "unit"), { recursive: true });
        await writeFile(
          join(root, selectedTest),
          `import {test} from ${JSON.stringify(pathToFileURL(resolve("node_modules/vitest/dist/index.js")).href)};
           import {createServer} from 'node:http';
           import {once} from 'node:events';
           test('workspace HTTP check', async () => {
             const server = createServer((_req, res) => res.end('ok')).listen(0, '127.0.0.1');
             await once(server, 'listening');
             try {
               const response = await fetch('http://127.0.0.1:' + server.address().port + '/interpret');
               if (await response.text() !== 'ok') throw new Error('Unexpected body');
             } finally { server.closeAllConnections(); server.close(); }
             await new Promise(resolve => setTimeout(resolve, 700));
           });`,
        );
      }
      const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
        const child = spawn(process.execPath, [resolve("agent/cli.mjs"), "run", root], {
          env: {
            ...process.env,
            GITHUB_ACTIONS: "false",
            TRACEYARD_ORIGIN: "http://127.0.0.1:" + address.port,
            ...(managed
              ? {
                  TRACEYARD_RUN_TOKEN: "tyr_" + "A".repeat(43),
                  TRACEYARD_MANAGED_RUN_ID: "managed_" + "a".repeat(32),
                  TRACEYARD_COMMIT_SHA: "a".repeat(40),
                }
              : { TRACEYARD_KEY: "tyk_" + "A".repeat(43) }),
          },
        });
        let output = "";
        child.stdout.on("data", (d) => (output += d));
        child.stderr.on("data", (d) => (output += d));
        child.on("error", reject);
        child.on("exit", (code) => done({ code, output }));
      });
      expect(result.output).not.toContain("tyk_");
      expect(result.output).not.toContain("tyr_");
      expect(result.code, result.output).toBe(expectedStatus === "FAILED" ? 1 : 0);
      const reports = received
        .filter((r) => r.path === "/api/v1/repository-runs")
        .map(
          (r) =>
            r.body as {
              phase: string;
              status: string;
              message: string;
              operations?: { name: string }[];
            },
        );
      expect(reports.find((r) => r.operations)?.operations?.[0]?.name).toBe("POST /interpret");
      expect(reports.at(-1)).toMatchObject({ phase: "complete", status: expectedStatus });
      if (focused) {
        expect(
          received.find((r) => r.path.endsWith(investigationId + "/report"))?.body,
        ).toMatchObject({
          status: "SUCCEEDED",
          command: { directory: "apps/api", script: "test:unit", testPath: selectedTest },
          counts: { passed: 1, failed: 0, skipped: 0 },
        });
      }
      if (expectedStatus === "FAILED") {
        expect(reports.find((r) => r.phase === "test" && r.status === "FAILED")?.message).toContain(
          "Supabase test configuration is missing",
        );
        expect(JSON.stringify(reports)).not.toContain("private@example.test");
      }
      const exports = received.filter((r) => r.path === "/api/v1/otlp/v1/traces");
      if (expectedStatus === "SKIPPED") {
        expect(exports).toHaveLength(0);
        return;
      }
      expect(exports.length, result.output).toBeGreaterThan(0);
      // The repository's own test process must never hold the reporting credential.
      if (!focused) {
        const testEnv = await readFile(join(root, "test-env.json"), "utf8");
        expect(testEnv).not.toMatch(/ty[kr]_A{43}/);
        expect(testEnv).not.toContain("OTEL_EXPORTER_OTLP_HEADERS");
        expect(JSON.parse(testEnv).OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toMatch(
          /^http:\/\/127\.0\.0\.1:\d+\/v1\/traces$/,
        );
      }
      expect(exports[0]?.authorization).toBe(
        "Bearer " + (managed ? "tyr_" : "tyk_") + "A".repeat(43),
      );
      expect(exports[0]?.contentType).toContain("application/json");
      const spans = exports.flatMap((r) => convertOtlp(r.body));
      expect(spanBatchSchema.safeParse({ spans: spans.slice(0, 50) }).success).toBe(true);
      expect(spans.some((s) => s.kind === "workflow")).toBe(true);
      expect(
        spans.some(
          (s) =>
            (s.attributes as Record<string, unknown>)["http.method"] === "GET" ||
            (s.attributes as Record<string, unknown>)["http.request.method"] === "GET",
        ),
        result.output,
      ).toBe(true);
      expect(spans[0]?.attributes.service).toContain(
        workspace && !focused ? "api" : "traceyard-agent-",
      );
      expect((spans[0]?.attributes as Record<string, unknown>)["traceyard.run.id"]).toMatch(
        managed ? /^managed_/ : /^local-/,
      );
      if (managed)
        expect(received.some((r) => r.path === "/api/v1/repository/register")).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        /* Windows file lock on temporary fixture directory */
      }
    }
  },
  60000,
);

it.runIf(process.platform !== "win32")(
  "runs through an npm-style symlink instead of exiting without scanning",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "traceyard-bin-"));
    try {
      await writeFile(join(root, "server.ts"), "app.get('/health', () => loadHealth());");
      const shortcut = join(root, "traceyard");
      await symlink(resolve("agent/cli.mjs"), shortcut);
      const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
        const child = spawn(process.execPath, [shortcut, "scan", root]);
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("error", reject);
        child.on("close", (code) => done({ code, output }));
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({
        filesScanned: 1,
        operations: [{ name: "GET /health" }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
