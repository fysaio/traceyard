import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/main.mjs";
import { verifyVerdict, isTestInput } from "../../packages/cli/src/verdicts.mjs";
import { compactFailure } from "../../packages/cli/src/compact.mjs";
import { failingTestsFromLog, parseActionsUrl } from "../../packages/core/src/ci-link.mjs";
import { cliResultSchema, type CliResult } from "../../shared/contracts/cli";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Traceyard", "-c", "user.email=t@traceyard.test", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

async function cli(repo: string, args: string[], options: Parameters<typeof main>[2] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    [...args, "--json", "--repo", repo],
    { stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
    { env: { ...process.env, VITEST: "" }, ...options },
  );
  expect(out).toHaveLength(1);
  const result = cliResultSchema.parse(JSON.parse(out[0]!)) as CliResult;
  expect(result.exitCode).toBe(code);
  // Agent-facing output stays small: well under 1,500 tokens (~6,000 characters).
  expect(out[0]!.length).toBeLessThan(6000);
  return result;
}

describe("traceyard CLI on a local repository", () => {
  let repo: string;
  let broken: string, fixed: string, cheat: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "traceyard-cli-"));
    const api = pathToFileURL(resolve("node_modules/vitest/dist/index.js")).href;
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({
        type: "module",
        scripts: { test: `node ${JSON.stringify(resolve("node_modules/vitest/vitest.mjs"))} run` },
      }),
    );
    await writeFile(
      join(repo, "sum.test.js"),
      `import {it,expect} from ${JSON.stringify(api)};import {sum} from './sum.js';it('adds numbers',()=>expect(sum(1,2)).toBe(3));it('adds zero',()=>expect(sum(2,0)).toBe(2));`,
    );
    await writeFile(join(repo, "sum.js"), "export const sum=(a,b)=>a-b;");
    // Vitest writes its cache under node_modules/.vite.
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "broken");
    broken = git(repo, "rev-parse", "HEAD");
    // An "agent fix" that edits the test instead of the code.
    const test = await readFile(join(repo, "sum.test.js"), "utf8");
    await writeFile(join(repo, "sum.test.js"), test.replace("toBe(3)", "toBe(-1)"));
    git(repo, "commit", "-qam", "loosen the test");
    cheat = git(repo, "rev-parse", "HEAD");
    git(repo, "reset", "-q", "--hard", broken);
    await writeFile(join(repo, "sum.js"), "export const sum=(a,b)=>a+b;");
    git(repo, "commit", "-qam", "fix");
    fixed = git(repo, "rev-parse", "HEAD");
  });
  afterAll(() => rm(repo, { recursive: true, force: true }));

  it("reproduces the failure at the exact commit and remembers the test", async () => {
    const result = await cli(repo, ["repro", "sum.test.js", "--at", broken.slice(0, 10)]);
    expect(result).toMatchObject({ command: "repro", verdict: "REPRODUCED", exitCode: 0 });
    expect(result.runs[0]).toMatchObject({ commit: broken, status: "FAILED", cached: false });
    expect(result.runs[0]!.failures[0]!.name).toContain("adds numbers");
    // Stack frames from the throwaway checkout are shortened to project paths.
    expect(result.runs[0]!.failures[0]!.message).not.toMatch(/traceyard-worktree-|node_modules/);
    expect(result.runs[0]!.output).toBeUndefined();

    const again = await cli(repo, ["repro", "sum.test.js", "--at", broken, "--log"]);
    expect(again.runs[0]!.cached).toBe(true);
    expect(await readFile(join(repo, ".traceyard", ".gitignore"), "utf8")).toBe("*\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
  }, 60_000);

  it("checks the working tree, including uncommitted edits", async () => {
    await writeFile(join(repo, "sum.js"), "export const sum=(a,b)=>a*b; // wip");
    const failing = await cli(repo, ["check"]);
    expect(failing).toMatchObject({ verdict: "FAILING", exitCode: 1 });
    expect(failing.runs[0]).toMatchObject({ workingTree: true, commit: null });
    git(repo, "checkout", "-q", "--", "sum.js");
    const passing = await cli(repo, ["check"]);
    expect(passing).toMatchObject({
      verdict: "PASSED",
      exitCode: 0,
      test: { path: "sum.test.js" },
    });
  }, 60_000);

  it("verifies a real fix and writes an intact receipt", async () => {
    const result = await cli(repo, ["verify"]);
    expect(result).toMatchObject({ verdict: "FIXED", exitCode: 0, changedTests: [] });
    expect(result.runs.map((r) => [r.role, r.commit, r.status])).toEqual([
      ["baseline", broken, "FAILED"],
      ["candidate", fixed, "SUCCEEDED"],
    ]);
    expect(result.runs[0]!.cached).toBe(true);
    const receipt = JSON.parse(await readFile(join(repo, result.receipt!.path), "utf8"));
    expect(receipt).toMatchObject({
      trust: "local",
      verdict: "FIXED",
      test: { path: "sum.test.js" },
    });
    expect(await readFile(join(repo, result.receipt!.markdownPath), "utf8")).toContain(
      "Traceyard receipt: FIXED",
    );
    const shown = await cli(repo, ["receipt"]);
    expect(shown).toMatchObject({ verdict: "FIXED", receipt: { id: receipt.id, intact: true } });

    // Editing the receipt breaks its digest.
    await writeFile(
      join(repo, result.receipt!.path),
      JSON.stringify({ ...receipt, verdict: "FIXED", summary: "edited" }),
    );
    const tampered = await cli(repo, ["receipt", receipt.id]);
    expect(tampered).toMatchObject({ verdict: "INCONCLUSIVE", receipt: { intact: false } });
  }, 60_000);

  it("flags a pass that came from editing the test", async () => {
    const result = await cli(repo, ["verify", "sum.test.js", "--before", broken, "--after", cheat]);
    expect(result).toMatchObject({ verdict: "NEEDS_REVIEW", exitCode: 2 });
    expect(result.changedTests).toEqual(["sum.test.js"]);
  }, 60_000);

  it("reports a test that passes at the failing commit as not reproduced", async () => {
    const repro = await cli(repo, ["repro", "sum.test.js", "--at", fixed]);
    expect(repro).toMatchObject({ verdict: "NOT_REPRODUCED", exitCode: 2 });
    const verify = await cli(repo, ["verify", "sum.test.js", "--before", fixed, "--after", fixed]);
    expect(verify).toMatchObject({ verdict: "NOT_REPRODUCED", exitCode: 2 });
    expect(verify.runs).toHaveLength(1);
  }, 60_000);

  it("blocks missing tests and commits with clear errors", async () => {
    const missing = await cli(repo, ["check", "nope.test.js"]);
    expect(missing).toMatchObject({ verdict: "BLOCKED", exitCode: 3 });
    expect(missing.summary).toMatch(/nope\.test\.js isn't a test file/);
    const unknown = await cli(repo, ["repro", "sum.test.js", "--at", "a".repeat(40)]);
    expect(unknown).toMatchObject({ verdict: "BLOCKED", exitCode: 3 });
    expect(unknown.summary).toMatch(/not in this clone/);
    expect(await cli(repo, ["repro", "sum.test.js", "--at", "no-such-branch"])).toMatchObject({
      verdict: "ERROR",
      exitCode: 64,
    });
    expect(await cli(repo, ["check", "--before", broken])).toMatchObject({ exitCode: 64 });
    expect(await cli(repo, ["launch"])).toMatchObject({ exitCode: 64 });
    expect(await cli(repo, ["repro", "x.test.js", "--case", "bad case"])).toMatchObject({
      exitCode: 64,
    });
  }, 60_000);

  it("reads the tested commit and failing test from a GitHub Actions job", async () => {
    git(repo, "remote", "add", "origin", "https://github.com/acme/shop.git");
    const log = [
      "2026-11-19T04:00:00.000Z Syncing repository: acme/shop",
      "2026-11-19T04:00:02.000Z [command]/usr/bin/git log -1 --format=%H",
      `2026-11-19T04:00:03.000Z ${broken}`,
      "2026-11-19T04:01:00.000Z  FAIL  sum.test.js > adds numbers",
    ].join("\n");
    const fetcher = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/jobs/7/logs")) return new Response(log);
      if (path.endsWith("/jobs/7"))
        return Response.json({ id: 7, run_id: 5, status: "completed", conclusion: "failure" });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const env = { ...process.env, VITEST: "", GITHUB_TOKEN: "test-token" };
    const result = await cli(
      repo,
      ["repro", "--from", "https://github.com/acme/shop/actions/runs/5/job/7"],
      { env, fetcher },
    );
    expect(result).toMatchObject({
      verdict: "REPRODUCED",
      test: { path: "sum.test.js" },
      source: { commit: broken, mergeCommit: false },
    });
    const other = await cli(
      repo,
      ["repro", "--from", "https://github.com/other/repo/actions/runs/5/job/7"],
      { env, fetcher },
    );
    expect(other).toMatchObject({ exitCode: 64 });
    expect(other.summary).toMatch(/acme\/shop/);
  }, 60_000);

  it("exits with the documented code from the bin script", () => {
    const run = spawnSync(
      process.execPath,
      [resolve("packages/cli/bin/traceyard.mjs"), "receipt", "--repo", repo, "--json"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(run.stdout).command).toBe("receipt");
    expect(run.status).toBe(JSON.parse(run.stdout).exitCode);
    const help = spawnSync(
      process.execPath,
      [resolve("packages/cli/bin/traceyard.mjs"), "--help"],
      {
        encoding: "utf8",
      },
    );
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/traceyard repro/);
  });

  it("never leaves worktrees or edits behind", async () => {
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect((await readdir(join(repo, ".traceyard", "runs"))).length).toBeGreaterThan(0);
  });
});

describe("dependencies at an exact commit", () => {
  it("links the clone's node_modules when the lockfile matches, and cleanup never deletes them", async () => {
    const repo = await mkdtemp(join(tmpdir(), "traceyard-cli-deps-"));
    try {
      const api = pathToFileURL(resolve("node_modules/vitest/dist/index.js")).href;
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          type: "module",
          scripts: {
            test: `node ${JSON.stringify(resolve("node_modules/vitest/vitest.mjs"))} run`,
          },
          dependencies: { "local-dep": "1.0.0" },
        }),
      );
      await writeFile(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
      await writeFile(join(repo, ".gitignore"), "node_modules/\n");
      await writeFile(
        join(repo, "dep.test.js"),
        `import {it,expect} from ${JSON.stringify(api)};import {value} from 'local-dep';it('reads the dependency',()=>expect(value).toBe(2));`,
      );
      git(repo, "init", "-q");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "init");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(repo, "node_modules", "local-dep"), { recursive: true });
      await writeFile(
        join(repo, "node_modules", "local-dep", "package.json"),
        JSON.stringify({ name: "local-dep", type: "module", main: "index.js" }),
      );
      await writeFile(
        join(repo, "node_modules", "local-dep", "index.js"),
        "export const value = 1;",
      );

      const result = await cli(repo, ["repro", "dep.test.js", "--at", "HEAD"]);
      expect(result).toMatchObject({ verdict: "REPRODUCED" });
      expect(result.runs[0]).toMatchObject({ dependencies: "linked" });
      expect(result.runs[0]!.failures[0]!.message).toMatch(/expected 1 to be 2/);
      expect(await readFile(join(repo, "node_modules", "local-dep", "index.js"), "utf8")).toContain(
        "value = 1",
      );
      expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("verdict rules", () => {
  const run = (status: "FAILED" | "SUCCEEDED" | "BLOCKED", commit: string, extra = {}) => ({
    commit,
    status,
    counts: {
      passed: status === "SUCCEEDED" ? 2 : 1,
      failed: status === "FAILED" ? 1 : 0,
      skipped: 0,
    },
    failures: status === "FAILED" ? [{ name: "adds", message: "expected 3" }] : [],
    message: "",
    ...extra,
  });
  const a = "a".repeat(40),
    b = "b".repeat(40);

  it("needs a reproduced failure and an unskipped pass to call it fixed", () => {
    const v = (
      baseline: ReturnType<typeof run>,
      candidate: ReturnType<typeof run>,
      files: string[] = [],
    ) => verifyVerdict({ baseline, candidate, testPath: "t.test.ts", changedFiles: files }).verdict;
    expect(v(run("FAILED", a), run("SUCCEEDED", b), ["src/sum.ts"])).toBe("FIXED");
    expect(v(run("FAILED", a), run("FAILED", b))).toBe("STILL_FAILING");
    expect(v(run("SUCCEEDED", a), run("SUCCEEDED", b))).toBe("NOT_REPRODUCED");
    expect(v(run("FAILED", a), run("BLOCKED", b))).toBe("BLOCKED");
    expect(v(run("FAILED", a), run("SUCCEEDED", a))).toBe("INCONCLUSIVE");
    expect(
      v(run("FAILED", a), run("SUCCEEDED", b, { counts: { passed: 1, failed: 0, skipped: 1 } })),
    ).toBe("INCONCLUSIVE");
    expect(v(run("FAILED", a), run("SUCCEEDED", b), ["src/__snapshots__/a.snap"])).toBe(
      "NEEDS_REVIEW",
    );
  });

  it("treats tests, fixtures, snapshots and runner config as test inputs", () => {
    for (const path of [
      "src/a.test.ts",
      "tests/helpers.ts",
      "src/__snapshots__/a.snap",
      "conftest.py",
      "vitest.config.ts",
    ])
      expect(isTestInput(path), path).toBe(true);
    for (const path of ["src/sum.ts", "README.md", "package.json"])
      expect(isTestInput(path), path).toBe(false);
  });
});

describe("CI job logs", () => {
  it("parses Actions links and failing test files", () => {
    expect(parseActionsUrl("https://github.com/a/b/actions/runs/1/attempts/2/job/3")).toEqual({
      repository: "a/b",
      runId: "1",
      attempt: "2",
      jobId: "3",
    });
    expect(parseActionsUrl("https://example.com/a/b/actions/runs/1")).toBeNull();
    expect(
      failingTestsFromLog(
        [
          "2026-01-01T00:00:00.0000000Z  FAIL  src/cart.test.ts > totals > adds tax",
          "\u001b[31mFAIL\u001b[39m src/api.spec.js (1.2 s)",
          " FAIL  src/cart.test.ts > totals > rounds",
          "FAILED tests/test_cart.py::test_total - AssertionError",
          " FAIL  ../outside.test.ts > x",
        ].join("\n"),
      ),
    ).toEqual(["src/cart.test.ts", "src/api.spec.js", "tests/test_cart.py"]);
  });

  it("keeps the assertion and first project frame from a stack", () => {
    expect(
      compactFailure(
        [
          "AssertionError: expected -1 to be 3",
          "    at /tmp/traceyard-worktree-Ab12/checkout/src/sum.test.js:3:44",
          "    at file:///repo/node_modules/@vitest/runner/dist/index.js:1:1",
          "    at /tmp/traceyard-worktree-Ab12/checkout/src/other.js:9:1",
        ].join("\n"),
      ),
    ).toBe("AssertionError: expected -1 to be 3\n    at src/sum.test.js:3:44");
  });
});
