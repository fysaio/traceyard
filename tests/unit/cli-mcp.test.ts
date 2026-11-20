import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalServer } from "../../packages/cli/src/mcp.mjs";
import { estimateTokens } from "../../packages/cli/src/compact.mjs";
import { main } from "../../packages/cli/src/main.mjs";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Traceyard", "-c", "user.email=t@traceyard.test", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const vitestApi = () => pathToFileURL(resolve("node_modules/vitest/dist/index.js")).href;
const vitestScript = () => `node ${JSON.stringify(resolve("node_modules/vitest/vitest.mjs"))} run`;

/** A repository with a failing commit and a fix commit on top (HEAD). */
async function demoRepo() {
  const repo = await mkdtemp(join(tmpdir(), "traceyard-mcp-"));
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ type: "module", scripts: { test: vitestScript() } }),
  );
  await writeFile(
    join(repo, "sum.test.js"),
    `import {it,expect} from ${JSON.stringify(vitestApi())};import {sum} from './sum.js';it('adds numbers',()=>expect(sum(1,2)).toBe(3));`,
  );
  await writeFile(join(repo, "sum.js"), "export const sum=(a,b)=>a-b;");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "broken");
  const broken = git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "sum.js"), "export const sum=(a,b)=>a+b;");
  git(repo, "commit", "-qam", "fix");
  return { repo, broken, fixed: git(repo, "rev-parse", "HEAD") };
}

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
};

describe("traceyard mcp", () => {
  let repo: string, broken: string, fixed: string;
  let client: Client;
  const tokens: Record<string, number> = {};

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    const text = result.content[0]!.text;
    // Every response fits the agent budget: well under 1,500 tokens.
    expect(estimateTokens(text)).toBeLessThan(1500);
    tokens[name] = Math.max(tokens[name] ?? 0, estimateTokens(text));
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    return result;
  };

  beforeAll(async () => {
    ({ repo, broken, fixed } = await demoRepo());
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await createLocalServer({ repo, env: { ...process.env, VITEST: "" } }).connect(serverSide);
    client = new Client({ name: "traceyard-test", version: "1.0.0" });
    await client.connect(clientSide);
  });
  afterAll(async () => {
    await client?.close();
    await rm(repo, { recursive: true, force: true });
  });

  it("offers the six local tools with agent instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check",
      "explain",
      "guard",
      "inspect",
      "reproduce",
      "verify",
    ]);
    expect(tools.find((t) => t.name === "inspect")!.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(client.getInstructions()).toMatch(/Fix the code, not the test/);
  });

  it("runs the whole loop: reproduce, check, verify, guard", async () => {
    const reproduced = await call("reproduce", { testPath: "sum.test.js", commit: broken });
    expect(reproduced.structuredContent).toMatchObject({
      schemaVersion: 1,
      status: "REPRODUCED",
      tool: "repro",
      exitCode: 0,
      omitted: false,
    });
    const run = (
      reproduced.structuredContent!.runs as { evidenceId: string; commit: string }[]
    )[0]!;
    expect(run.commit).toBe(broken);

    expect((await call("check")).structuredContent).toMatchObject({
      status: "PASSED",
      test: { path: "sum.test.js" },
    });
    const verified = await call("verify");
    expect(verified.structuredContent).toMatchObject({ status: "FIXED", changedTests: [] });
    expect((await call("guard")).structuredContent).toMatchObject({ status: "FIXED" });

    // Repeating a run at the same commit reuses the recorded result.
    const again = await call("reproduce", { testPath: "sum.test.js", commit: broken });
    expect((again.structuredContent!.runs as { cached: boolean }[])[0]!.cached).toBe(true);
  }, 60_000);

  it("explains a failure and pages through its log", async () => {
    const explained = await call("explain");
    expect(explained.structuredContent).toMatchObject({
      status: "AVAILABLE",
      explanation: { location: { path: "sum.test.js" }, source: { commit: broken } },
    });
    const listed = await call("inspect");
    const items = listed.structuredContent!.items as { kind: string; id: string }[];
    const id = items.find((i) => i.kind === "run")!.id;
    // Log slices page like the hosted inspect tool: summary holds the text.
    const page = await call("inspect", { evidenceId: id, outputChars: 1200 });
    expect(page.structuredContent).toMatchObject({
      status: "AVAILABLE",
      evidenceId: id,
      offset: 0,
    });
    expect(page.content[0]!.text.length * 2 + 200).toBeLessThanOrEqual(1200);
    const next = page.structuredContent!.nextOffset as number | null;
    if (next !== null) {
      const more = await call("inspect", { evidenceId: id, offset: next, outputChars: 1200 });
      expect(more.structuredContent).toMatchObject({ offset: next });
    }
    const receiptId = items.find((i) => i.kind === "receipt")!.id;
    const receipt = await call("inspect", { receiptId });
    expect(receipt.structuredContent).toMatchObject({
      status: "FIXED",
      receipt: { id: receiptId, intact: true, markdown: expect.stringContaining("receipt") },
    });
  }, 60_000);

  it("keeps small budgets small and reports errors as tool errors", async () => {
    const small = await call("reproduce", {
      testPath: "sum.test.js",
      commit: broken,
      outputChars: 2000,
    });
    expect(small.content[0]!.text.length * 2 + 200).toBeLessThanOrEqual(2000);
    const bad = await call("verify", { before: "no-such-branch" });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({ status: "ERROR", exitCode: 64 });
    const invalid = (await client.callTool({
      name: "reproduce",
      arguments: { testPath: "../outside.test.js" },
    })) as ToolResult;
    expect(invalid.isError).toBe(true);
    expect(git(repo, "rev-parse", "HEAD")).toBe(fixed);
    expect(git(repo, "status", "--porcelain")).toBe("");
  }, 60_000);

  it("records tokens returned per tool call", () => {
    // The budget the tests enforce, recorded so regressions show up in review.
    for (const name of ["reproduce", "check", "verify", "guard", "explain", "inspect"])
      expect(tokens[name], name).toBeGreaterThan(0);
    expect(Math.max(...Object.values(tokens))).toBeLessThan(1500);
  });
});

describe("traceyard mcp over stdio", () => {
  it("serves tools from the bin script and writes nothing else to stdout", async () => {
    const { repo, broken } = await demoRepo();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("packages/cli/bin/traceyard.mjs"), "mcp", "--repo", repo],
      env: { ...process.env, VITEST: "" } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(6);
      const result = (await client.callTool({
        name: "reproduce",
        arguments: { testPath: "sum.test.js", commit: broken },
      })) as ToolResult;
      expect(result.structuredContent).toMatchObject({ status: "REPRODUCED" });
    } finally {
      await client.close();
      await rm(repo, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects arguments to the mcp command", async () => {
    const err: string[] = [];
    const code = await main(["mcp", "extra"], { stdout: () => {}, stderr: (l) => err.push(l) });
    expect(code).toBe(64);
    expect(err.join("\n")).toMatch(/takes no arguments/);
  });
});

describe("dependency cache", () => {
  // Installs one tiny package from the npm registry, once.
  it("installs a lockfile's dependencies once and reuses them at other commits", async () => {
    const repo = await mkdtemp(join(tmpdir(), "traceyard-depcache-"));
    const cache = await mkdtemp(join(tmpdir(), "traceyard-cache-"));
    try {
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({
          name: "depcache-fixture",
          version: "1.0.0",
          type: "module",
          scripts: { test: vitestScript() },
          dependencies: { "is-number": "7.0.0" },
        }),
      );
      execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit"], {
        cwd: repo,
        shell: process.platform === "win32",
        stdio: "ignore",
      });
      await writeFile(join(repo, ".gitignore"), "node_modules/\n");
      await writeFile(
        join(repo, "n.test.js"),
        `import {it,expect} from ${JSON.stringify(vitestApi())};import isNumber from 'is-number';it('checks',()=>expect(isNumber('x')).toBe(true));`,
      );
      git(repo, "init", "-q");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "one");
      const first = git(repo, "rev-parse", "HEAD");
      await writeFile(join(repo, "README.md"), "two\n");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "two");

      const out: string[] = [];
      const run = async (at: string) => {
        out.length = 0;
        await main(
          ["repro", "n.test.js", "--at", at, "--json", "--repo", repo],
          { stdout: (l) => out.push(l), stderr: () => {} },
          { env: { ...process.env, VITEST: "", TRACEYARD_CACHE_DIR: cache } },
        );
        return JSON.parse(out[0]!);
      };
      const cold = await run(first);
      expect(cold).toMatchObject({ verdict: "REPRODUCED" });
      expect(cold.runs[0].dependencies).toBe("installed");
      const warm = await run("HEAD");
      expect(warm).toMatchObject({ verdict: "REPRODUCED" });
      expect(warm.runs[0].dependencies).toBe("cached");
      // One dependency set in the cache, and nothing installed in the clone.
      expect(await readdir(join(cache, "deps"))).toHaveLength(1);
      await expect(readdir(join(repo, "node_modules"))).rejects.toThrow();
      expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(cache, { recursive: true, force: true });
    }
  }, 180_000);
});
