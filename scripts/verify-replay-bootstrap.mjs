// Runs in the packaged runner image, which deliberately has no Docker daemon.
// Proves replay never executes application installation hooks before its isolation check.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const agent = process.argv.includes("--agent")
  ? resolve(process.argv[process.argv.indexOf("--agent") + 1])
  : "/opt/traceyard/agent/cli.mjs";
const root = await mkdtemp(join(tmpdir(), "traceyard-replay-bootstrap-")),
  sha = "a".repeat(40),
  id = "managed_" + "d".repeat(32),
  inv = "inv_" + "e".repeat(32),
  requestId = "req_" + "f".repeat(32),
  reports = [];
const collector = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.method === "GET") {
    assert.equal(request.headers["x-traceyard-runner-protocol"], "2");
    response.end(
      JSON.stringify({
        data: {
          config: { directory: ".", startScript: "", port: 3000 },
          cases: [],
          investigation: {
            investigationId: inv,
            requestId,
            question: "Replay existing assertion",
            testPath: "replay.test.mjs",
            commit: sha,
            timeoutMs: 10000,
            replayRecording: {
              id: "rcd_" + "a".repeat(32),
              manifest: {
                schemaVersion: 1,
                kind: "json-fetch",
                sourceCommit: sha,
                testPath: "replay.test.mjs",
                interactions: [
                  {
                    method: "GET",
                    url: "https://provider.example/value",
                    requestBody: null,
                    signature: createHash("sha256")
                      .update(
                        JSON.stringify({
                          body: null,
                          method: "GET",
                          url: "https://provider.example/value",
                        }),
                      )
                      .digest("hex"),
                    response: { status: 200, body: { value: 42 } },
                  },
                ],
                environment: [],
                omissions: [],
                eligible: true,
              },
            },
          },
        },
      }),
    );
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (request.url.endsWith("/report")) reports.push(JSON.parse(raw));
  response.end('{"data":{"received":true}}');
});
await new Promise((done) => collector.listen(0, "127.0.0.1", done));
try {
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "replay-bootstrap-fixture",
      version: "1.0.0",
      type: "module",
      scripts: {
        test: "node ./vitest.mjs",
        install: "node -e \"require('fs').writeFileSync('install-hook-ran','unsafe')\"",
      },
    }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "replay-bootstrap-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "replay-bootstrap-fixture", version: "1.0.0", hasInstallScript: true },
      },
    }),
  );
  await writeFile(join(root, "replay.test.mjs"), "test('existing assertion',()=>{});");
  await writeFile(join(root, "vitest.mjs"), "throw Error('Unisolated test was executed');");
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [agent, "run", root], {
      env: {
        PATH: process.env.PATH,
        TRACEYARD_ORIGIN: "http://127.0.0.1:" + collector.address().port,
        TRACEYARD_MANAGED_RUN_ID: id,
        TRACEYARD_COMMIT_SHA: sha,
        TRACEYARD_RUN_TOKEN: "tyr_" + "A".repeat(43),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("Replay bootstrap timed out"));
    }, 30000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
  assert.equal(result.code, 1, result.output);
  assert.equal(reports.length, 1, result.output);
  assert.equal(reports[0].status, "BLOCKED");
  assert.match(reports[0].message, /isolation is unavailable/);
  await assert.rejects(access(join(root, "install-hook-ran")));
  assert.ok(!result.output.includes("Unisolated test was executed"), result.output);
  console.log(
    "Replay bootstrap passed: installation hooks skipped; missing isolation blocked test execution.",
  );
} finally {
  collector.closeAllConnections();
  await new Promise((done) => collector.close(done));
  await rm(root, { recursive: true, force: true });
}
