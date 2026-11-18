// Reproducible local fixture. Measures evidence bytes and executed checks, not agent token savings.
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { indexRepository } from "../agent/repository-index.mjs";
import { runInvestigationPlan } from "../agent/test-evidence.mjs";
const root = await mkdtemp(join(tmpdir(), "traceyard-benchmark-"));
try {
  const api = pathToFileURL(resolve("node_modules/vitest/dist/index.js")).href;
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: `node ${JSON.stringify(resolve("node_modules/vitest/vitest.mjs"))} run` },
    }),
  );
  await writeFile(join(root, "sum.js"), "export const sum=(a,b)=>a-b;");
  await writeFile(
    join(root, "sum.test.js"),
    `import {it,expect} from ${JSON.stringify(api)};import {sum} from './sum.js';it('adds numbers',()=>expect(sum(1,2)).toBe(3));`,
  );
  for (let n = 0; n < 11; n++)
    await writeFile(
      join(root, `unrelated-${n}.test.js`),
      `import {it,expect} from ${JSON.stringify(api)};it('unrelated invariant ${n}',()=>expect(${n}+1).toBe(${n + 1}));`,
    );
  const started = Date.now();
  const baseline = await new Promise((done, reject) => {
    const child = spawn(
      "npm",
      [
        "test",
        "--",
        "--reporter=verbose",
        "--reporter=json",
        "--outputFile.json=" + join(root, "baseline.json"),
      ],
      {
        cwd: root,
        env: { ...process.env, VITEST: "", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", reject);
    child.on("close", (code) => done({ code, log, durationMs: Date.now() - started }));
  });
  assert.equal(baseline.code, 1);
  const raw = JSON.parse(await readFile(join(root, "baseline.json"), "utf8"));
  const plan = {
    investigationId: "inv_" + "a".repeat(32),
    requestId: "req_" + "b".repeat(32),
    question: "Investigate sum",
    testPath: "sum.test.js",
    commit: null,
    timeoutMs: 30000,
  };
  const failed = await runInvestigationPlan(root, await indexRepository(root), plan, {
    ...process.env,
    VITEST: "",
  });
  assert.equal(failed.status, "FAILED");
  await writeFile(join(root, "sum.js"), "export const sum=(a,b)=>a+b;");
  const verified = await runInvestigationPlan(
    root,
    await indexRepository(root),
    { ...plan, changedFiles: ["sum.js"], maxTestFiles: 3 },
    { ...process.env, VITEST: "" },
  );
  assert.equal(verified.status, "SUCCEEDED");
  const before = Buffer.byteLength(baseline.log + JSON.stringify(raw)),
    after = Buffer.byteLength(JSON.stringify(failed));
  const result = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    fixture: "12 independent Vitest files; one arithmetic defect; no external services",
    baseline: {
      testFiles: raw.testResults.length,
      tests: raw.numTotalTests,
      evidenceBytes: before,
      durationMs: baseline.durationMs,
    },
    focused: {
      testFiles: failed.checks.length,
      tests: failed.counts,
      evidenceBytes: after,
      durationMs: failed.durationMs,
    },
    repair: {
      status: verified.status,
      testFiles: verified.checks.length,
      tests: verified.counts,
      omittedRelatedTests: verified.coverage.omittedTests,
      durationMs: verified.durationMs,
    },
    evidenceReductionPercent: Number(((1 - after / before) * 100).toFixed(1)),
    paidModelCallsByTraceyard: 0,
    providerCallsInFixture: 0,
    agentTokens: null,
    limitations: [
      "A controlled fixture, not a production workload or general savings guarantee.",
      "Local execution durations exclude hosted checkout and dependency installation.",
      "Evidence bytes are not tokens. Coding-agent reasoning and provider billing were not measured.",
      "Replay cost and isolation are tested separately in the Docker CI acceptance.",
    ],
  };
  const output = process.argv.indexOf("--output");
  if (output >= 0)
    await writeFile(process.argv[output + 1], JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
