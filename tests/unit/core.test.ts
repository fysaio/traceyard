import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adapterForFile,
  adapterForScript,
  detectPackageManager,
  installCommand,
  parsePackageManagerField,
  runLocalTest,
  runTargetedTest,
  indexRepository,
  scriptCommand,
} from "../../packages/core/src/index.mjs";

const bin = (name: string) => (process.platform === "win32" ? name + ".cmd" : name);

async function temporary(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("package manager detection", () => {
  it("reads the Corepack packageManager field", () => {
    expect(parsePackageManagerField("pnpm@9.15.0+sha512.abc")).toEqual({ name: "pnpm", major: 9 });
    expect(parsePackageManagerField("yarn@1.22.22")).toEqual({ name: "yarn", major: 1 });
    expect(parsePackageManagerField("deno@2")).toBeNull();
    expect(parsePackageManagerField(undefined)).toBeNull();
  });

  it("prefers packageManager, then lockfiles, walking up to the workspace root", async () => {
    const root = await temporary("traceyard-pm-");
    try {
      await mkdir(join(root, "packages", "web"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
      await writeFile(join(root, "packages", "web", "package.json"), "{}");
      expect((await detectPackageManager(root, join(root, "packages", "web"))).source).toBe(
        "default",
      );

      await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const pnpm = await detectPackageManager(root, join(root, "packages", "web"));
      expect(pnpm).toMatchObject({ name: "pnpm", installRoot: root, lockfile: "pnpm-lock.yaml" });

      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ private: true, packageManager: "yarn@4.5.0" }),
      );
      expect(await detectPackageManager(root, join(root, "packages", "web"))).toMatchObject({
        name: "yarn",
        major: 4,
        source: "packageManager",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards test arguments correctly for each manager", () => {
    expect(scriptCommand("npm", "test", ["a.test.ts"])).toEqual({
      program: bin("npm"),
      args: ["run", "test", "--", "a.test.ts"],
    });
    // pnpm would hand a literal `--` to the runner, so it is omitted.
    expect(scriptCommand({ name: "pnpm", major: 9 }, "test", ["a.test.ts"]).args).toEqual([
      "run",
      "test",
      "a.test.ts",
    ]);
    expect(scriptCommand("yarn", "test", ["a"]).args).toEqual(["run", "test", "a"]);
  });

  it("installs from the lockfile without lifecycle scripts", () => {
    expect(installCommand("npm").args).toContain("--ignore-scripts");
    expect(installCommand({ name: "yarn", major: 1 }).args).toContain("--frozen-lockfile");
    expect(installCommand({ name: "yarn", major: 4 }).args).toEqual([
      "install",
      "--immutable",
      "--mode=skip-build",
    ]);
    expect(installCommand("pnpm").args).toContain("--frozen-lockfile");
  });
});

describe("runner adapters", () => {
  it("maps scripts and files to the right adapter", () => {
    expect(adapterForScript("vitest run")?.name).toBe("vitest");
    expect(adapterForScript("jest --ci")?.name).toBe("jest");
    expect(adapterForScript('node "./node_modules/vitest/vitest.mjs" run')?.name).toBe("vitest");
    expect(adapterForScript("vitest run && eslint .")?.name).toBe("vitest");
    expect(adapterForScript("mocha")).toBeNull();
    expect(adapterForFile("tests/test_checkout.py")?.name).toBe("pytest");
    expect(adapterForFile("src/sum.test.ts")).toBeNull();
  });

  it("builds focused runner arguments", () => {
    const vitest = adapterForScript("vitest")!;
    expect(
      vitest.args({ testArgument: "a.test.ts", output: "/o.json", plan: { flakeCandidate: "x" } }),
    ).toEqual(["--run", "--reporter=json", "--retry=0", "a.test.ts", "--outputFile=/o.json"]);
    expect(adapterForScript("jest")!.args({ testArgument: "a", output: "o", plan: {} })).toContain(
      "--runTestsByPath",
    );
  });
});

describe("local runs at an exact commit", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Traceyard", "-c", "user.email=t@traceyard.test", ...args],
      { cwd, encoding: "utf8" },
    ).trim();

  it("reproduces a failure at one SHA, passes at the fix, and leaves the working tree alone", async () => {
    const repo = await temporary("traceyard-local-");
    try {
      const api = pathToFileURL(resolve("node_modules/vitest/dist/index.js")).href;
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          type: "module",
          scripts: {
            test: `node ${JSON.stringify(resolve("node_modules/vitest/vitest.mjs"))} run`,
          },
        }),
      );
      await writeFile(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
      await writeFile(
        join(repo, "sum.test.js"),
        `import {it,expect} from ${JSON.stringify(api)};import {sum} from './sum.js';it('adds numbers',()=>expect(sum(1,2)).toBe(3));`,
      );
      await writeFile(join(repo, "sum.js"), "export const sum=(a,b)=>a-b;");
      git(repo, "init", "-q");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "broken");
      const broken = git(repo, "rev-parse", "HEAD");
      await writeFile(join(repo, "sum.js"), "export const sum=(a,b)=>a+b;");
      git(repo, "commit", "-qam", "fix");
      const fixed = git(repo, "rev-parse", "HEAD");
      // Uncommitted work in progress must survive both runs.
      await writeFile(join(repo, "sum.js"), "export const sum=(a,b)=>a*b; // wip");

      const env = { ...process.env, VITEST: "" };
      const before = await runLocalTest({
        repo,
        commit: broken.slice(0, 12),
        testPath: "sum.test.js",
        env,
        timeoutMs: 30000,
      });
      expect(before.status).toBe("FAILED");
      expect(before.commit).toBe(broken);
      expect(before.failures[0]?.name).toContain("adds numbers");

      const after = await runLocalTest({
        repo,
        commit: fixed,
        testPath: "sum.test.js",
        env,
        timeoutMs: 30000,
      });
      expect(after.status).toBe("SUCCEEDED");
      expect(after.counts.passed).toBe(1);

      expect(await readFile(join(repo, "sum.js"), "utf8")).toContain("// wip");
      expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);

  it("never fetches unless asked and explains how to get the commit", async () => {
    const repo = await temporary("traceyard-nofetch-");
    try {
      git(repo, "init", "-q");
      await expect(
        runLocalTest({ repo, commit: "a".repeat(40), testPath: "x.test.js" }),
      ).rejects.toThrow(/not in this clone/);
      await expect(runLocalTest({ repo, commit: "main;rm", testPath: "x" })).rejects.toThrow(
        /commit SHA/,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("blocks recorded replays when no isolated runner is provided", async () => {
    const repo = await temporary("traceyard-replay-");
    try {
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      await writeFile(join(repo, "a.test.js"), "test('a',()=>{})");
      const result = await runTargetedTest(
        repo,
        await indexRepository(repo),
        {
          question: "",
          testPath: "a.test.js",
          timeoutMs: 5000,
          replayRecording: { id: "rec" },
        } as never,
        process.env,
      );
      expect(result.status).toBe("BLOCKED");
      expect(result.message).toMatch(/isolated Traceyard runner/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
