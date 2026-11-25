import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { convertOtlp } from "../../worker/repositories/otlp";
it.each([true, false])(
  "executes a saved HTTP request against a real application with verdict %s",
  async (passed) => {
    const root = await mkdtemp(join(tmpdir(), "traceyard-request-"));
    const reserve = createServer();
    await new Promise<void>((r) => reserve.listen(0, "127.0.0.1", r));
    const bound = reserve.address();
    if (!bound || typeof bound === "string") throw Error("No test port");
    const port = bound.port;
    const reports: {
        phase: string;
        status: string;
        testResults?: {
          status: string;
          checks: { passed: boolean }[];
          responsePreview?: string;
          traceId: string;
        }[];
      }[] = [],
      exports: unknown[] = [];
    const collector = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") {
        res.end(
          JSON.stringify({
            data: {
              config: { directory: ".", startScript: "start:test", port },
              cases: [
                {
                  id: "case_actual",
                  operationKey: "op_actual",
                  name: "Checks response",
                  method: "GET",
                  path: "/health",
                  expectedStatus: 200,
                  responsePath: "ready",
                  expectedValue: passed,
                  captureResponse: true,
                },
              ],
            },
          }),
        );
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (req.url?.includes("otlp")) exports.push(body);
      else if (req.url?.includes("repository-runs")) reports.push(body);
      res.end(JSON.stringify({ data: { received: true } }));
    });
    await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
    // Release the application port only after the collector is bound, so the
    // operating system cannot assign the same ephemeral port to both servers.
    await new Promise<void>((r) => reserve.close(() => r()));
    const addr = collector.address();
    if (!addr || typeof addr === "string") throw Error("No collector");
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "request-fixture",
          version: "1.0.0",
          scripts: { "start:test": "node server.cjs" },
        }),
      );
      await writeFile(
        join(root, "package-lock.json"),
        JSON.stringify({
          name: "request-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: { "": { name: "request-fixture", version: "1.0.0" } },
        }),
      );
      await writeFile(
        join(root, "server.cjs"),
        `require('node:http').createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready:true,token:'secret-fixture-token'}))}).listen(Number(process.env.PORT),'127.0.0.1');`,
      );
      const run = await new Promise<{ code: number | null; output: string }>((done, reject) => {
        const c = spawn(
          process.execPath,
          [resolve("agent/cli.mjs"), "run", root, "--case", "case_actual"],
          {
            env: {
              ...process.env,
              GITHUB_ACTIONS: "false",
              TRACEYARD_ORIGIN: "http://127.0.0.1:" + addr.port,
              TRACEYARD_KEY: "tyk_" + "A".repeat(43),
            },
          },
        );
        let output = "";
        c.stdout.on("data", (d) => (output += d));
        c.stderr.on("data", (d) => (output += d));
        c.once("error", reject);
        c.once("exit", (code) => done({ code, output }));
      });
      expect(run.code, run.output).toBe(passed ? 0 : 1);
      expect(run.output).not.toContain("tyk_");
      const result = reports.find((r) => r.testResults?.length)?.testResults?.[0];
      expect(result?.status, run.output).toBe(passed ? "SUCCEEDED" : "FAILED");
      expect(result?.checks.map((c) => c.passed)).toEqual([true, passed]);
      expect(result?.responsePreview).toContain("[redacted]");
      expect(result?.responsePreview).not.toContain("secret-fixture-token");
      expect(reports.at(-1)?.status).toBe(passed ? "SUCCEEDED" : "FAILED");
      const spans = exports.flatMap(convertOtlp);
      expect(
        spans.some(
          (s) =>
            s.traceId === result?.traceId &&
            (s.attributes as Record<string, unknown>)["traceyard.operation.key"] === "op_actual",
        ),
      ).toBe(true);
      expect(
        spans.some((span) => span.traceId === result?.traceId && !!span.parentSpanId),
        run.output,
      ).toBe(true);
      // Parent cleanup must stop the application process rather than leaving a local server running.
      await expect(fetch("http://127.0.0.1:" + port + "/health")).rejects.toThrow();
    } finally {
      collector.closeAllConnections();
      await new Promise<void>((r) => collector.close(() => r()));
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        /* Windows file lock on temporary fixture directory */
      }
    }
  },
  60000,
);
