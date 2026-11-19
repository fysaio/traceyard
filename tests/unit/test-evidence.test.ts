import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runOriginalTest } from "../../agent/cli.mjs";
import { pathToFileURL } from "node:url";
import { analyzeRepositoryFiles, indexRepository } from "../../agent/repository-index.mjs";
import {
  normalizeVitestReport,
  runTargetedTest,
  runInvestigationPlan,
  selectTest,
} from "../../agent/test-evidence.mjs";
import { investigationReportSchema } from "../../shared/contracts/investigation-execution";
describe("focused investigation evidence", () => {
  it("keeps assertion evidence bounded and distinguishes initialization failures from success", () => {
    const result = normalizeVitestReport(
      {
        numPassedTests: 0,
        numFailedTests: 1,
        testResults: [
          {
            name: "case.test.ts",
            status: "failed",
            assertionResults: [
              {
                status: "failed",
                fullName: "guard before mock",
                failureMessages: ["GROQ_API_KEY_PRIMARY is missing; Bearer abcdefghijklmnopqrstuv"],
              },
            ],
          },
        ],
      },
      1,
    );
    expect(result.status).toBe("FAILED");
    expect(result.message).toContain("before requesting real credentials");
    expect(result.failures[0]?.message).not.toContain("abcdefghijklmnopqrstuv");
    expect(normalizeVitestReport({ numPassedTests: 0, numFailedTests: 0 }, 0).status).toBe(
      "BLOCKED",
    );
  });
  it("catches a weakened assertion and accepts a code repair using the original Git files", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceyard-original-case-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    const commit = (description: string) => {
      git("add", "--all");
      git("commit", "--no-verify", "--no-gpg-sign", "-m", description);
      return git("rev-parse", "HEAD");
    };
    const write = (file: string, value: string) => writeFile(join(root, file), value);
    try {
      git("init");
      await write(".gitignore", "node_modules/\n");
      await mkdir(join(root, "fixtures"));
      const api = pathToFileURL(resolve("node_modules/vitest/dist/index.js")).href;
      const original = `import {it,expect} from ${JSON.stringify(api)};import {sum} from './sum.js';import {expected} from './fixtures/expected.js';it('adds',()=>expect(sum(1,2)).toBe(expected));`;
      const weakened = original.replace(".toBe(expected)", ".toBeTypeOf('number')");
      await write(
        "package.json",
        JSON.stringify({
          type: "module",
          name: "traceyard-original",
          version: "1.0.0",
          scripts: {
            test: `node ${JSON.stringify(resolve("node_modules/vitest/vitest.mjs"))} run`,
          },
        }),
      );
      await write(
        "package-lock.json",
        JSON.stringify({
          name: "traceyard-original",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: { "": { name: "traceyard-original", version: "1.0.0" } },
        }),
      );
      await write("sum.js", "export const sum=(a,b)=>a-b;");
      await write("sum.test.js", original);
      await write("fixtures/expected.js", "export const expected=3;");
      const baselineCommit = commit("Failure");
      await write("sum.test.js", weakened);
      await write("fixtures/expected.js", "export const expected=-1;");
      await write("fixtures/new.js", "export default true;");
      const fake = commit("Weaken the test");
      const plan = {
        investigationId: "inv_" + "a".repeat(32),
        requestId: "req_" + "b".repeat(32),
        question: "Verify the repair",
        testPath: "sum.test.js",
        timeoutMs: 20000,
        commit: fake,
        originalTest: {
          baselineCommit,
          assertionName: "adds",
          paths: ["sum.test.js", "fixtures/expected.js", "fixtures/new.js"],
        },
      };
      const testEnv = { ...process.env, VITEST: "" };
      expect((await runTargetedTest(root, await indexRepository(root), plan, testEnv)).status).toBe(
        "SUCCEEDED",
      );
      const result = await runOriginalTest(root, plan, testEnv);
      expect(result, JSON.stringify(result)).toMatchObject({
        baselineCommit,
        status: "FAILED",
        assertion: "FAILED",
        failures: [{ file: "sum.test.js", name: "adds" }],
      });
      expect(await readFile(join(root, "sum.test.js"), "utf8")).toBe(weakened);
      expect(git("status", "--porcelain")).toBe("");
      await write("sum.js", "export const sum=(a,b)=>a+b;");
      const fixed = commit("Repair the application");
      expect(await runOriginalTest(root, { ...plan, commit: fixed }, testEnv)).toMatchObject({
        status: "SUCCEEDED",
        assertion: "PASSED",
        counts: { passed: 1, failed: 0 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
  it("selects a clear existing test and returns ambiguity without running unrelated work", () => {
    const index = analyzeRepositoryFiles([
      { path: "today.test.ts", content: "test('proposal',()=>{})" },
      { path: "memory.test.ts", content: "test('remember',()=>{})" },
    ]);
    expect(selectTest(index, "Investigate Today proposal tests").test?.path).toBe("today.test.ts");
    expect(selectTest(index, "Investigate the failing tests").test).toBeUndefined();
    expect(selectTest(index, "Inspect", "missing.test.ts").test).toBeUndefined();
  });
  it("executes an actual Vitest fixture, retains its failed assertion and sees the repaired result", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceyard-focused-"));
    try {
      const api = pathToFileURL(resolve("node_modules/vitest/dist/index.js")).href;
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          type: "module",
          scripts: {
            test: `node ${JSON.stringify(resolve("node_modules/vitest/vitest.mjs"))} run`,
          },
        }),
      );
      await writeFile(join(root, "sum.js"), "export const sum=(a,b)=>a-b;");
      await writeFile(
        join(root, "sum.test.js"),
        `import {it,expect} from ${JSON.stringify(api)};import {sum} from './sum.js';it('adds numbers',()=>expect(sum(1,2)).toBe(3));`,
      );
      const plan = {
        investigationId: "inv_" + "a".repeat(32),
        requestId: "req_" + "b".repeat(32),
        question: "Investigate sum",
        testPath: "sum.test.js",
        commit: null,
        timeoutMs: 20000,
      };
      const failed = await runTargetedTest(root, await indexRepository(root), plan, {
        ...process.env,
        VITEST: "",
      });
      expect(failed.status, JSON.stringify(failed)).toBe("FAILED");
      expect(failed.failures[0]?.name).toContain("adds numbers");
      expect(failed.command.testPath).toBe("sum.test.js");
      expect(failed.output).toContain("vitest.mjs");
      expect(
        investigationReportSchema.safeParse({
          ...failed,
          requestId: plan.requestId,
          runId: "local-fixture",
          commit: null,
        }).success,
      ).toBe(true);
      await writeFile(join(root, "sum.js"), "export const sum=(a,b)=>a+b;");
      const fixed = await runTargetedTest(root, await indexRepository(root), plan, {
        ...process.env,
        VITEST: "",
      });
      expect(fixed.status, JSON.stringify(fixed)).toBe("SUCCEEDED");
      expect(fixed.counts.passed).toBe(1);
      await writeFile(
        join(root, "regression.test.js"),
        `import {it,expect} from ${JSON.stringify(api)};import {sum} from './sum.js';it('adds other numbers',()=>expect(sum(2,3)).toBe(5));`,
      );
      const verified = await runInvestigationPlan(
        root,
        await indexRepository(root),
        { ...plan, changedFiles: ["sum.js"], maxTestFiles: 2 },
        { ...process.env, VITEST: "" },
      );
      expect(verified.status, JSON.stringify(verified)).toBe("SUCCEEDED");
      expect(verified.checks).toHaveLength(2);
      expect(verified.coverage?.omittedTests).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});

it.each(["vitest", "jest"] as const)(
  "runs only the selected React or JavaScript test through the real %s CLI",
  async (runner) => {
    const root = await mkdtemp(join(resolve("."), ".traceyard-package-"));
    try {
      const isJest = runner === "jest";
      const command = isJest ? "jest --maxWorkers=2" : "vitest run";
      const file = isJest ? "checkout.test.cjs" : "checkout.test.tsx";
      const test = isJest
        ? "const { label } = require('./checkout.cjs'); test('checkout label', () => expect(label).toBe('Done'));"
        : "import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {test,expect} from 'vitest'; import {label} from './checkout.cjs'; test('checkout label',()=>expect(renderToStaticMarkup(<button>{label}</button>)).toBe('<button>Done</button>'));";
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ scripts: { "test:unit": command } }),
      );
      await writeFile(join(root, file), test);
      await writeFile(
        join(root, "unrelated.test.cjs"),
        "test('must not run',()=>{ throw Error('unrelated'); });",
      );
      const plan = {
        investigationId: "inv_" + "a".repeat(32),
        requestId: "req_" + "b".repeat(32),
        question: "Run checkout test",
        testPath: file,
        commit: null,
        timeoutMs: 20000,
      };
      await writeFile(join(root, "checkout.cjs"), "exports.label = 'Broken';");
      const run = async () =>
        runTargetedTest(root, await indexRepository(root), plan, {
          ...process.env,
          CI: "true",
          VITEST: "",
        });
      const baseline = await run();
      expect(baseline.status, baseline.message).toBe("FAILED");
      expect(baseline.failures).toHaveLength(1);
      expect(baseline.failures[0]?.file).toBe(file);
      expect(baseline.failures[0]?.name).toContain("checkout label");
      await writeFile(join(root, "checkout.cjs"), "exports.label = 'Done';");
      const repaired = await run();
      expect(repaired.status, repaired.message).toBe("SUCCEEDED");
      expect(repaired.counts).toMatchObject({ passed: 1, failed: 0 });
      expect(repaired.command.testPath).toBe(file);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
  60000,
);
