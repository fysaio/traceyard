import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
