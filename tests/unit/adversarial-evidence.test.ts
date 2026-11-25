import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/main.mjs";
import {
  isJavaScriptTestInput,
  isPytestInput,
  isTestInput,
  runnerConfigChange,
  runnerConfigDigest,
  scriptConfigPath,
} from "../../packages/core/src/test-inputs.mjs";
import { cliResultSchema, type CliResult } from "../../shared/contracts/cli";

// Hostile "fix" commits: each one makes the failing test pass without fixing
// the code, by changing how the test runs rather than what it tests. None may
// come back FIXED.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Traceyard", "-c", "user.email=t@traceyard.test", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

async function verify(repo: string, before: string, after: string) {
  const out: string[] = [];
  const code = await main(
    ["verify", "sum.test.js", "--before", before, "--after", after, "--json", "--repo", repo],
    { stdout: (l) => out.push(l), stderr: () => {} },
    { env: { ...process.env, VITEST: "" } },
  );
  const result = cliResultSchema.parse(JSON.parse(out[0]!)) as CliResult;
  expect(result.exitCode).toBe(code);
  return result;
}

describe("hostile fix commits on a local repository", () => {
  let repo: string;
  let broken: string;
  const vitest = JSON.stringify(resolve("node_modules/vitest/vitest.mjs"));
  const api = JSON.stringify(pathToFileURL(resolve("node_modules/vitest/dist/index.js")).href);
  const script = (extra = "") => `node ${vitest} run${extra}`;
  const pkg = (test: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "module", scripts: { test }, ...extra });
  // Vitest only hoists vi.mock imported from "vitest", so every config maps it.
  const config = (setup?: string) =>
    `export default {resolve:{alias:{vitest:${JSON.stringify(resolve("node_modules/vitest/dist/index.js"))}}},test:{${setup ? `setupFiles:['${setup}']` : ""}}};`;
  // A setup module that mocks the code under test so the assertion passes.
  const mockingSetup = `import {vi} from 'vitest';vi.mock('./sum.js',()=>({sum:(a,b)=>a+b}));`;

  /** Commit `files` on top of the broken commit and return the new SHA. */
  async function hostile(message: string, files: Record<string, string>) {
    git(repo, "checkout", "-q", "--detach", broken);
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
    git(repo, "add", ".");
    git(repo, "commit", "-qm", message);
    return git(repo, "rev-parse", "HEAD");
  }

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "traceyard-hostile-"));
    await writeFile(join(repo, "package.json"), pkg(script(" --config ./ci.config.js")));
    await writeFile(join(repo, "ci.config.js"), config());
    await writeFile(
      join(repo, "sum.test.js"),
      `import {it,expect} from ${api};import {sum} from './sum.js';it('adds numbers',()=>expect(sum(1,2)).toBe(3));`,
    );
    await writeFile(join(repo, "sum.js"), "export const sum=(a,b)=>a-b;");
    await writeFile(join(repo, ".gitignore"), "node_modules/\n.traceyard/\n");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "broken");
    broken = git(repo, "rev-parse", "HEAD");
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  it("flags a test script that points at a different, mocking config", async () => {
    const cheat = await hostile("switch the test config", {
      "package.json": pkg(script(" --config ./lenient.js")),
      "lenient.js": config("./boot.js"),
      "boot.js": mockingSetup,
    });
    const result = await verify(repo, broken, cheat);
    // The pass is real, but it came from the runner configuration.
    expect(result.runs[1]).toMatchObject({ status: "SUCCEEDED" });
    expect(result).toMatchObject({ verdict: "NEEDS_REVIEW", exitCode: 2 });
    expect(result.changedTests).toEqual(["package.json"]);
    expect(result.evidenceEnvelope?.claim).not.toBe("FOCUSED_PASS");
  }, 60_000);

  it("flags an edit to the config file the script names, whatever it is called", async () => {
    const cheat = await hostile("mock through the existing config", {
      "ci.config.js": config("./boot.js"),
      "boot.js": mockingSetup,
    });
    const result = await verify(repo, broken, cheat);
    expect(result.runs[1]).toMatchObject({ status: "SUCCEEDED" });
    expect(result).toMatchObject({ verdict: "NEEDS_REVIEW", changedTests: ["package.json"] });
  }, 60_000);

  it("flags a setup file picked up by a conventional name", async () => {
    const cheat = await hostile("add a vitest setup file", {
      "ci.config.js": config("./vitest.setup.js"),
      "vitest.setup.js": mockingSetup,
    });
    const result = await verify(repo, broken, cheat);
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(result.changedTests).toEqual(expect.arrayContaining(["vitest.setup.js"]));
  }, 60_000);

  it("does not count a passing script that filters the failing test away", async () => {
    const cheat = await hostile("only run other tests", {
      "package.json": pkg(script(" --config ./ci.config.js --passWithNoTests -t nothing-matches")),
    });
    const result = await verify(repo, broken, cheat);
    expect(result.verdict).not.toBe("FIXED");
    expect(result.evidenceEnvelope?.claim).not.toBe("FOCUSED_PASS");
  }, 60_000);

  it("still calls a real code fix FIXED", async () => {
    const fix = await hostile("fix", { "sum.js": "export const sum=(a,b)=>a+b;" });
    const result = await verify(repo, broken, fix);
    expect(result).toMatchObject({ verdict: "FIXED", changedTests: [] });
  }, 60_000);
});

describe("test-input rules", () => {
  it("covers tests, fixtures, setup files and runner configuration", () => {
    for (const path of [
      "src/a.test.ts",
      "tests/helpers.ts",
      "src/__mocks__/db.ts",
      "src/__snapshots__/a.snap",
      "vitest.config.ts",
      "vitest.config.e2e.mts",
      "vitest.workspace.ts",
      "jest.config.json",
      "packages/app/jest.config.cjs",
      "vitest.setup.ts",
      "jest.setup.js",
      "src/setupTests.ts",
      "src/test-setup.js",
      "src/db.setup.ts",
    ])
      expect(isJavaScriptTestInput(path), path).toBe(true);
    for (const path of ["src/sum.ts", "README.md", "package.json", "src/setup.ts", "vite-env.d.ts"])
      expect(isTestInput(path), path).toBe(false);
    expect(isPytestInput("conftest.py")).toBe(true);
    expect(isJavaScriptTestInput("conftest.py")).toBe(false);
  });

  it("reads the config a script names", () => {
    expect(scriptConfigPath("vitest run --config ./ci.config.ts")).toBe("./ci.config.ts");
    expect(scriptConfigPath("jest -c=jest.ci.js --ci")).toBe("jest.ci.js");
    expect(scriptConfigPath('vitest --config "cfg/a.ts"')).toBe("cfg/a.ts");
    expect(scriptConfigPath("vitest run")).toBeNull();
  });

  it("changes the runner digest for the script, the jest key and the named config", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceyard-digest-"));
    try {
      await writeFile(join(root, "a.js"), "one");
      const base = { scripts: { test: "jest -c a.js" }, jest: { testTimeout: 5 } };
      const digest = (pkg: object) =>
        runnerConfigDigest({ root, directory: root, pkg, script: "test" });
      const first = await digest(base);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(await digest(base)).toBe(first);
      expect(await digest({ ...base, jest: { testTimeout: 6 } })).not.toBe(first);
      expect(await digest({ ...base, scripts: { test: "jest -c a.js --silent" } })).not.toBe(first);
      await writeFile(join(root, "a.js"), "two");
      expect(await digest(base)).not.toBe(first);
      // A config outside the repository can't be read into the digest; it is marked instead.
      const outsideFile = join(await mkdtemp(join(tmpdir(), "traceyard-outside-")), "c.js");
      await writeFile(outsideFile, "one");
      const outside = { scripts: { test: `jest -c ${outsideFile}` } };
      const marked = await digest(outside);
      await writeFile(outsideFile, "two");
      expect(await digest(outside)).toBe(marked);
      await rm(join(outsideFile, ".."), { recursive: true, force: true, maxRetries: 5 }).catch(
        () => {},
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
  });

  it("reports a changed or missing runner configuration between two runs", () => {
    const a = "a".repeat(64),
      b = "b".repeat(64);
    expect(runnerConfigChange({ runnerConfig: a }, { runnerConfig: a })).toEqual({
      changed: [],
      unknown: false,
    });
    expect(runnerConfigChange({ runnerConfig: a }, { runnerConfig: b }, "packages/app")).toEqual({
      changed: ["packages/app/package.json"],
      unknown: false,
    });
    expect(runnerConfigChange({ runnerConfig: a }, { runnerConfig: b }, ".").changed).toEqual([
      "package.json",
    ]);
    expect(runnerConfigChange({ runnerConfig: a }, {})).toEqual({ changed: [], unknown: true });
    expect(runnerConfigChange({}, { runnerConfig: b }, ".", ["package.json"])).toEqual({
      changed: ["package.json"],
      unknown: true,
    });
    expect(runnerConfigChange({}, {})).toEqual({ changed: [], unknown: false });
  });
});
