#!/usr/bin/env node
// Assembles the publishable `traceyard` npm package in dist/npm/traceyard.
// packages/cli and packages/core keep their relative layout under lib/, so the
// CLI's `../../core/src` imports work unchanged.
//
//   node scripts/pack-cli.mjs [--name @fysaio/traceyard] [--out dir]
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: { name: { type: "string", default: "traceyard" }, out: { type: "string" } },
});
const read = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));

const cli = await read("packages/cli/package.json");
const core = await read("packages/core/package.json");
const lock = await read("package-lock.json");

const out = resolve(values.out ?? join(root, "dist/npm", values.name.replace(/^@[^/]+\//, "")));
await rm(out, { recursive: true, force: true });
const runtimeOnly = (source) => !source.endsWith(".d.mts") && !source.endsWith(".test.mjs");
for (const [from, to] of [
  ["packages/cli/bin", "lib/cli/bin"],
  ["packages/cli/src", "lib/cli/src"],
  ["packages/core/src", "lib/core/src"],
])
  await cp(join(root, from), join(out, to), { recursive: true, filter: runtimeOnly });
await writeFile(
  join(out, "lib/cli/package.json"),
  JSON.stringify({ version: cli.version, type: "module", private: true }, null, 2) + "\n",
);

// Pin runtime dependencies to what the repository tests against.
const pinned = (name) => {
  const version = lock.packages[`node_modules/${name}`]?.version;
  if (!version) throw Error(`${name} is missing from package-lock.json`);
  return name === "@modelcontextprotocol/sdk" ? version : `^${version}`;
};
const dependencies = Object.fromEntries(
  ["@babel/parser", "@modelcontextprotocol/sdk", "zod"].map((name) => [name, pinned(name)]),
);
for (const name of Object.keys(core.dependencies ?? {}))
  if (!(name in dependencies)) throw Error(`Add ${name} to the published dependencies.`);

const manifest = {
  name: values.name,
  version: cli.version,
  description: cli.description,
  license: cli.license,
  type: "module",
  bin: { traceyard: "lib/cli/bin/traceyard.mjs" },
  files: ["lib", "README.md", "LICENSE"],
  engines: cli.engines,
  dependencies,
  keywords: [
    "testing",
    "ci",
    "reproduce",
    "flaky-tests",
    "mcp",
    "coding-agents",
    "vitest",
    "jest",
    "pytest",
  ],
  homepage: "https://github.com/fysaio/traceyard/blob/main/docs/CLI.md",
  repository: {
    type: "git",
    url: "git+https://github.com/fysaio/traceyard.git",
    directory: "packages/cli",
  },
  bugs: { url: "https://github.com/fysaio/traceyard/issues" },
  publishConfig: values.name.startsWith("@")
    ? { registry: "https://npm.pkg.github.com", access: "public" }
    : { access: "public", provenance: true },
};
await writeFile(join(out, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
await cp(join(root, "LICENSE"), join(out, "LICENSE"));
const guide = await readFile(join(root, "docs/CLI.md"), "utf8");
await writeFile(
  join(out, "README.md"),
  guide.replace(
    /\]\((?!https?:|#)([^)]+)\)/g,
    (_, link) => `](https://github.com/fysaio/traceyard/blob/main/docs/${link})`,
  ),
);
await mkdir(out, { recursive: true });
console.log(`${manifest.name}@${manifest.version} -> ${out}`);
