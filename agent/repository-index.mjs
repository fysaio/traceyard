import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import { posix, resolve, relative, join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "@babel/parser";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const isCode = (path) => /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.[cm]?[jt]s$/.test(path);
const isTest = (path) =>
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|tests?|specs?)\/)/.test(path);
const ignored = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".git",
  ".next",
  ".traceyard-runner",
  ".venv",
]);
function visit(node, fn) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") fn(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "comments", "tokens"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((x) => visit(x, fn));
    else if (value && typeof value === "object") visit(value, fn);
  }
}
function callName(node) {
  return node?.type === "Identifier"
    ? node.name
    : node?.type === "MemberExpression"
      ? `${callName(node.object)}.${callName(node.property)}`
      : "";
}
export function analyzeRepositoryFiles(input) {
  const files = [...input].sort((a, b) => a.path.localeCompare(b.path));
  const paths = new Set(files.map((f) => f.path)),
    warnings = [],
    packages = [],
    aliases = [];
  for (const f of files.filter((f) => /(?:^|\/)package.json$/.test(f.path))) {
    try {
      const p = JSON.parse(f.content),
        lock =
          files.find((l) => l.path === posix.join(posix.dirname(f.path), "package-lock.json")) ??
          files.find((l) => l.path === "package-lock.json"),
        script = String(p.scripts?.test ?? ""),
        directory = posix.dirname(f.path);
      const dependencies = { ...p.dependencies, ...p.devDependencies };
      packages.push({
        directory,
        name: String(p.name ?? directory).slice(0, 150),
        scripts: Object.keys(p.scripts ?? {})
          .filter((n) => /^[A-Za-z0-9:_-]{1,80}$/.test(n))
          .slice(0, 50),
        testRunner: /vitest/.test(script)
          ? "vitest"
          : /jest/.test(script)
            ? "jest"
            : /node\s+--test/.test(script)
              ? "node"
              : dependencies.vitest
                ? "vitest"
                : "unknown",
        manager: paths.has(posix.join(directory, "pnpm-lock.yaml"))
          ? "pnpm"
          : paths.has(posix.join(directory, "yarn.lock"))
            ? "yarn"
            : "npm",
        hash: hash(f.content),
        lockHash: lock ? hash(lock.content) : null,
      });
    } catch {
      warnings.push(`Cannot parse manifest: ${f.path}`);
    }
  }
  for (const f of files.filter((f) => /(?:^|\/)tsconfig[^/]*\.json$/.test(f.path))) {
    try {
      const config = JSON.parse(f.content),
        base = posix.join(posix.dirname(f.path), config.compilerOptions?.baseUrl ?? ".");
      for (const [key, values] of Object.entries(config.compilerOptions?.paths ?? {})) {
        for (const value of Array.isArray(values) ? values : [])
          if (typeof value === "string")
            aliases.push({ key, value, base, root: posix.dirname(f.path) });
      }
    } catch {
      warnings.push(`Alias configuration needs unsupported JSON syntax: ${f.path}`);
    }
  }
  const find = (base) => {
    const variants = [
      base,
      ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"].map(
        (ext) => base + ext,
      ),
    ];
    if (/\.[cm]?js$/.test(base)) variants.push(base.replace(/\.[cm]?js$/, ".ts"));
    return variants.find((p) => paths.has(p)) ?? null;
  };
  const resolveImport = (from, specifier) => {
    if (specifier.startsWith("."))
      return find(posix.normalize(posix.join(posix.dirname(from), specifier)));
    for (const a of aliases) {
      // A package-specific configuration must never resolve imports in another workspace.
      const configRoot = a.root === "." ? "" : a.root + "/";
      if (configRoot && !from.startsWith(configRoot)) continue;
      const [before, after = ""] = a.key.split("*");
      if (
        a.key.includes("*")
          ? specifier.startsWith(before) && specifier.endsWith(after)
          : specifier === a.key
      ) {
        const middle = a.key.includes("*")
          ? specifier.slice(before.length, specifier.length - after.length)
          : "";
        const found = find(posix.join(a.base, a.value.replace("*", middle)));
        if (found) return found;
      }
    }
    for (const p of packages)
      if (specifier === p.name) {
        const found =
          find(posix.join(p.directory, "src/index")) ?? find(posix.join(p.directory, "index"));
        if (found) return found;
      }
    return null;
  };
  const indexed = [];
  for (const f of files.filter((f) => isCode(f.path))) {
    const record = {
      path: f.path,
      hash: hash(f.content),
      imports: [],
      tests: [],
      definitions: [],
      isTest: isTest(f.path),
      packageDirectory:
        [...packages]
          .sort((a, b) => b.directory.length - a.directory.length)
          .find((p) => p.directory === "." || f.path.startsWith(p.directory + "/"))?.directory ??
        ".",
    };
    try {
      const ast = parse(f.content, {
        sourceType: "unambiguous",
        plugins: ["typescript", "jsx"],
        errorRecovery: false,
      });
      const imports = new Set();
      visit(ast.program, (node) => {
        if (
          ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(
            node.type,
          ) &&
          node.source?.value
        )
          imports.add(node.source.value);
        if (
          node.type === "CallExpression" &&
          node.callee?.name === "require" &&
          node.arguments[0]?.type === "StringLiteral"
        )
          imports.add(node.arguments[0].value);
        if (
          record.isTest &&
          node.type === "CallExpression" &&
          /^(?:it|test|describe)(?:\.(?:only|skip|todo|concurrent|sequential|each))*$/.test(
            callName(node.callee),
          ) &&
          node.arguments[0]?.type === "StringLiteral" &&
          record.tests.length < 40
        )
          record.tests.push({
            name: node.arguments[0].value.slice(0, 200),
            line: node.loc?.start.line ?? 1,
          });
        if (
          ["FunctionDeclaration", "ClassDeclaration"].includes(node.type) &&
          node.id?.name &&
          record.definitions.length < 40
        )
          record.definitions.push(node.id.name.slice(0, 100));
      });
      record.imports = [...imports].slice(0, 40).map((specifier) => ({
        specifier: specifier.slice(0, 240),
        resolved: resolveImport(f.path, specifier),
      }));
      if (imports.size > 40) warnings.push(`Import relationships truncated: ${f.path}`);
    } catch {
      warnings.push(`Cannot parse source: ${f.path}`);
    }
    record.isTest =
      record.isTest &&
      (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(record.path) || record.tests.length > 0);
    if (Buffer.byteLength(JSON.stringify(record)) > 20000) {
      warnings.push(`File metadata truncated: ${f.path}`);
      while (Buffer.byteLength(JSON.stringify(record)) > 20000) {
        if (record.imports.length) record.imports.pop();
        else if (record.tests.length) record.tests.pop();
        else record.definitions.pop();
      }
    }
    indexed.push(record);
  }
  return {
    schemaVersion: 1,
    snapshotId: hash(JSON.stringify(files.map((f) => [f.path, hash(f.content)]))),
    packages: packages.slice(0, 50),
    files: indexed,
    coverage: {
      scanned: indexed.length,
      skipped: 0,
      truncated: packages.length > 50 || warnings.some((w) => w.includes("truncated")),
      warnings: warnings.slice(0, 20),
    },
  };
}
export function relatedTests(index, sourcePath) {
  const selected = new Set([sourcePath]);
  for (let i = 0; i <= index.files.length; i++) {
    let changed = false;
    for (const file of index.files)
      if (
        !selected.has(file.path) &&
        file.imports.some((x) => x.resolved && selected.has(x.resolved))
      ) {
        selected.add(file.path);
        changed = true;
      }
    if (!changed) break;
  }
  return index.files
    .filter((f) => f.isTest && selected.has(f.path))
    .map((f) => ({ path: f.path, packageDirectory: f.packageDirectory, tests: f.tests }));
}
export async function indexRepository(directory) {
  const root = await realpath(directory),
    files = [],
    warnings = [];
  let bytes = 0,
    skipped = 0;
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink() || ignored.has(e.name) || e.name.startsWith(".env")) continue;
      const full = join(dir, e.name),
        path = relative(root, full).split("\\").join("/");
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) await walk(full);
        continue;
      }
      if (!(
        isCode(path) ||
        /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(
          path,
        )
      ))
        continue;
      if (
        path.length > 240 ||
        files.length >= 5000 ||
        bytes >= 12_000_000 ||
        (await lstat(full)).size > (/lock|yarn/.test(e.name) ? 2000000 : 128000)
      ) {
        skipped++;
        continue;
      }
      const content = await readFile(resolve(root, path), "utf8");
      bytes += Buffer.byteLength(content);
      files.push({ path, content });
    }
  }
  await walk(root);
  const index = analyzeRepositoryFiles(files);
  if (skipped)
    warnings.push(`Repository index skipped ${skipped} file(s) because of size/count limits.`);
  index.coverage.skipped = skipped;
  index.coverage.truncated ||= skipped > 0;
  index.coverage.warnings.push(...warnings);
  return index;
}
