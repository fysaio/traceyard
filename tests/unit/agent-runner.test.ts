import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { convertOtlp } from "../../worker/repositories/otlp";
import { spanBatchSchema } from "../../shared/contracts/traces";

it.each(["SUCCEEDED", "FAILED", "SKIPPED"])(
  "runs real project checks and reports %s with actual automatic spans where exercised",
  async (expectedStatus) => {
    const root = await mkdtemp(join(tmpdir(), "traceyard-agent-"));
    const received: {
      path: string;
      body: unknown;
      authorization?: string;
      contentType?: string;
    }[] = [];
    const server = createServer(async (req, res) => {
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
        join(root, "package.json"),
        JSON.stringify({
          name: "agent-fixture",
          version: "1.0.0",
          type: "module",
          scripts: expectedStatus === "SKIPPED" ? {} : { test: "node --test test.mjs" },
        }),
      );
      await writeFile(
        join(root, "package-lock.json"),
        JSON.stringify({
          name: "agent-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: { "": { name: "agent-fixture", version: "1.0.0" } },
        }),
      );
      await writeFile(join(root, "server.ts"), "app.post('/interpret',async()=>generateReply());");
      await writeFile(
        join(root, "test.mjs"),
        `import {test} from 'node:test';import {createServer} from 'node:http';import {once} from 'node:events';test('application HTTP flow',async()=>{const server=createServer((req,res)=>res.end('ok'));server.listen(0,'127.0.0.1');await once(server,'listening');const response=await fetch('http://127.0.0.1:'+server.address().port+'/interpret');await response.text();server.closeAllConnections();server.close();${expectedStatus === "FAILED" ? "throw new Error('Expected fixture failure');" : ""}});`,
      );
      const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
        const child = spawn(process.execPath, [resolve("agent/cli.mjs"), "run", root], {
          env: {
            ...process.env,
            GITHUB_ACTIONS: "false",
            TRACEYARD_ORIGIN: "http://127.0.0.1:" + address.port,
            TRACEYARD_KEY: "tyk_" + "A".repeat(43),
          },
        });
        let output = "";
        child.stdout.on("data", (d) => (output += d));
        child.stderr.on("data", (d) => (output += d));
        child.on("error", reject);
        child.on("exit", (code) => done({ code, output }));
      });
      expect(result.output).not.toContain("tyk_");
      expect(result.code, result.output).toBe(expectedStatus === "FAILED" ? 1 : 0);
      const reports = received
        .filter((r) => r.path === "/api/v1/repository-runs")
        .map((r) => r.body as { phase: string; status: string; operations?: { name: string }[] });
      expect(reports.find((r) => r.operations)?.operations?.[0]?.name).toBe("POST /interpret");
      expect(reports.at(-1)).toMatchObject({ phase: "complete", status: expectedStatus });
      const exports = received.filter((r) => r.path === "/api/v1/otlp/v1/traces");
      if (expectedStatus === "SKIPPED") {
        expect(exports).toHaveLength(0);
        return;
      }
      expect(exports.length, result.output).toBeGreaterThan(0);
      expect(exports[0]?.authorization).toBe("Bearer tyk_" + "A".repeat(43));
      expect(exports[0]?.contentType).toContain("application/json");
      const spans = exports.flatMap((r) => convertOtlp(r.body));
      expect(spanBatchSchema.safeParse({ spans: spans.slice(0, 50) }).success).toBe(true);
      expect(spans.some((s) => s.kind === "workflow")).toBe(true);
      expect(spans[0]?.attributes.service).toContain("traceyard-agent-");
      expect((spans[0]?.attributes as Record<string, unknown>)["traceyard.run.id"]).toMatch(
        /^local-/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
