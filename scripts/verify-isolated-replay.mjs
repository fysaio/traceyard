// CI acceptance: real capture, failing reproducer, repair and divergence with Docker network disabled.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { buildRecording } from "../agent/recording.mjs";
import { replayVitest } from "../agent/replay-runner.mjs";
const root = resolve("."),
  fixture = await mkdtemp(join(root, "tests/unit/replay-acceptance-"));
const testPath = fixture.slice(root.length + 1) + "/recorded.test.ts",
  capture = join(fixture, "capture.jsonl");
let calls = 0;
const server = createServer((_request, response) => {
  calls++;
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"value":42}');
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/value`;
try {
  const captured = await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        resolve("agent/record-fetch.mjs"),
        "--input-type=module",
        "-e",
        `await (await fetch(${JSON.stringify(url)})).json()`,
      ],
      { env: { ...process.env, TRACEYARD_CAPTURE_FILE: capture }, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("close", done);
  });
  assert.equal(captured, 0);
  const manifest = await buildRecording(capture, "a".repeat(40), testPath);
  assert.equal(manifest.eligible, true);
  // Keep the mount small: a dedicated fixture snapshot with its own Vitest package.
  const snapshot = join(fixture, "snapshot");
  await mkdir(snapshot);
  const { cp } = await import("node:fs/promises");
  await cp(join(root, "node_modules"), join(snapshot, "node_modules"), { recursive: true });
  await writeFile(
    join(snapshot, "package.json"),
    JSON.stringify({ type: "module", scripts: { test: "vitest run --pool=forks" } }),
  );
  const source = (expected, path = url) =>
    `import {it,expect} from 'vitest'; import {writeFileSync} from 'node:fs'; it('uses retained JSON',async()=>{writeFileSync('disposable.txt','isolated'); const data=await (await fetch(${JSON.stringify(path)})).json();expect(data.value).toBe(${expected});});`;
  const file = join(snapshot, "recorded.test.ts");
  manifest.testPath = "recorded.test.ts";
  const plan = {
    investigationId: "fixture",
    requestId: "fixture",
    question: "Replay existing test",
    commit: manifest.sourceCommit,
    timeoutMs: 120000,
    replayRecording: { id: "rcd_fixture", manifest },
  };
  const invocation = { directory: ".", script: "test", testPath: "recorded.test.ts" };
  await writeFile(file, source(41));
  const failed = await replayVitest(snapshot, invocation, plan);
  assert.equal(failed.status, "FAILED", JSON.stringify(failed));
  assert.equal(failed.replay.reusedRequests, 1);
  await writeFile(file, source(42));
  const passed = await replayVitest(snapshot, invocation, plan);
  assert.equal(passed.status, "SUCCEEDED", JSON.stringify(passed));
  assert.equal(passed.replay.isolation, "docker-network-none");
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(join(snapshot, "disposable.txt")));
  await writeFile(file, source(42, url + "-changed"));
  const diverged = await replayVitest(snapshot, invocation, plan);
  assert.equal(diverged.status, "BLOCKED", JSON.stringify(diverged));
  assert.equal(diverged.replay.diverged, true);
  assert.equal(calls, 1, "Replay must never contact the live provider");
  console.log(
    "Isolated replay passed: captured once, reproduced failure, verified repair, blocked divergence, preserved host snapshot.",
  );
} finally {
  await new Promise((done) => server.close(done));
  await rm(fixture, { recursive: true, verbatimSymlinks: true, force: true });
}
