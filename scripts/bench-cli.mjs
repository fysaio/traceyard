#!/usr/bin/env node
// Tokens returned per local MCP tool call, and how long each call takes, on a
// small Vitest repository. Writes docs/benchmarks/cli-agent.json.
//
//   node scripts/bench-cli.mjs [--out <file>]
//
// Tokens are estimated as characters / 4, the same rule the tests enforce.
// Durations include Vitest start-up; cached calls show the cost of a repeat.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLocalServer } from "../packages/cli/src/mcp.mjs";
import { estimateTokens } from "../packages/cli/src/compact.mjs";
import { VERSION } from "../packages/cli/src/version.mjs";

const { values } = parseArgs({
  options: { out: { type: "string", default: "docs/benchmarks/cli-agent.json" } },
});
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=Bench", "-c", "user.email=b@traceyard.test", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const repo = await mkdtemp(join(tmpdir(), "traceyard-bench-cli-"));
const cache = await mkdtemp(join(tmpdir(), "traceyard-bench-cache-"));
try {
  const api = pathToFileURL(resolve("node_modules/vitest/dist/index.js")).href;
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: `node ${JSON.stringify(resolve("node_modules/vitest/vitest.mjs"))} run` },
    }),
  );
  // Ten cases; the broken total is off by one for carts over five items, so seven fail.
  const cases = Array.from(
    { length: 10 },
    (_, i) =>
      `it('total ${i}',()=>{const items=Array.from({length:${i + 2}},(_,k)=>({price:k+1,qty:2}));expect(total(items)).toBe(items.reduce((s,x)=>s+x.price*x.qty,0));});`,
  ).join("\n");
  await writeFile(
    join(repo, "cart.test.js"),
    `import {it,expect} from ${JSON.stringify(api)};\nimport {total} from './cart.js';\n${cases}\n`,
  );
  await writeFile(
    join(repo, "cart.js"),
    "export const total=(items)=>items.reduce((s,x)=>s+x.price*x.qty,0)+(items.length>5?1:0);\n",
  );
  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "broken");
  const broken = git(repo, "rev-parse", "HEAD");
  await writeFile(
    join(repo, "cart.js"),
    "export const total=(items)=>items.reduce((s,x)=>s+x.price*x.qty,0);\n",
  );
  git(repo, "commit", "-qam", "fix");

  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createLocalServer({
    repo,
    env: { ...process.env, VITEST: "", TRACEYARD_CACHE_DIR: cache },
  }).connect(serverSide);
  const client = new Client({ name: "bench", version: VERSION });
  await client.connect(clientSide);

  const calls = [];
  const call = async (label, name, args = {}) => {
    const started = performance.now();
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    calls.push({
      call: label,
      tool: name,
      status: result.structuredContent?.status ?? null,
      chars: text.length,
      tokens: estimateTokens(text),
      durationMs: Math.round(performance.now() - started),
    });
    return result;
  };
  await call("reproduce (cold)", "reproduce", { testPath: "cart.test.js", commit: broken });
  await call("reproduce (cached)", "reproduce", { testPath: "cart.test.js", commit: broken });
  await call("explain", "explain");
  const listed = await call("inspect (recent)", "inspect");
  const run = listed.structuredContent.items.find((i) => i.kind === "run");
  await call("inspect (log slice)", "inspect", { evidenceId: run.id });
  await call("check", "check");
  await call("verify", "verify");
  await call("guard", "guard");
  await client.close();

  const report = {
    tool: { name: "traceyard", version: VERSION },
    measuredAt: new Date().toISOString(),
    environment: { node: process.version, platform: `${process.platform}-${process.arch}` },
    budget: { tokensPerCall: 1500, outputCharsDefault: 4000 },
    calls,
    totals: {
      tokens: calls.reduce((s, c) => s + c.tokens, 0),
      maxTokensPerCall: Math.max(...calls.map((c) => c.tokens)),
    },
    notes: [
      "Tokens are estimated as characters / 4. Provider tokenizers differ.",
      "Full logs are never returned up front; inspect pages through them by evidence ID.",
      "Durations include Vitest start-up on this machine and exclude dependency installs.",
    ],
  };
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (report.totals.maxTokensPerCall >= 1500) {
    console.error("A tool call returned 1,500 tokens or more.");
    process.exitCode = 1;
  }
} finally {
  await rm(repo, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
}
