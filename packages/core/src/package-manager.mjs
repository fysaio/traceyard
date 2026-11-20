import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

// Lockfiles in order of preference when a directory has more than one.
const lockfiles = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];
const names = new Set(["npm", "pnpm", "yarn", "bun"]);

const exists = (path) =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  );

async function readPackageJson(directory) {
  try {
    return JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Parse the Corepack `packageManager` field, for example "pnpm@9.15.0+sha512...". */
export function parsePackageManagerField(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(npm|pnpm|yarn|bun)@(\d+)(?:\.\d+){0,2}/);
  return match ? { name: match[1], major: Number(match[2]) } : null;
}

/**
 * Find the package manager that owns `packageDirectory`, walking up to `root`.
 * The Corepack `packageManager` field wins over lockfiles because it is explicit.
 * Returns the directory where installs must run, which is the workspace root for
 * monorepos.
 */
export async function detectPackageManager(root, packageDirectory = root) {
  const top = resolve(root);
  let directory = resolve(packageDirectory);
  if (relative(top, directory).startsWith("..")) directory = top;
  for (;;) {
    const pkg = await readPackageJson(directory);
    const declared = parsePackageManagerField(pkg?.packageManager);
    if (declared)
      return { ...declared, installRoot: directory, source: "packageManager", lockfile: null };
    for (const [file, name] of lockfiles)
      if (await exists(join(directory, file)))
        return { name, major: null, installRoot: directory, source: "lockfile", lockfile: file };
    if (directory === top) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return {
    name: "npm",
    major: null,
    installRoot: resolve(packageDirectory),
    source: "default",
    lockfile: null,
  };
}

const binary = (name) => (process.platform === "win32" ? name + ".cmd" : name);

/**
 * Command that runs a package.json script with extra arguments. npm needs `--`
 * before forwarded arguments; pnpm, Yarn and Bun forward everything after the
 * script name, and pnpm would pass a literal `--` through to the test runner.
 */
export function scriptCommand(manager, script, args = []) {
  const name = names.has(manager?.name ?? manager) ? (manager?.name ?? manager) : "npm";
  if (name === "npm") return { program: binary("npm"), args: ["run", script, "--", ...args] };
  return { program: binary(name), args: ["run", script, ...args] };
}

/** Reproducible install command for a clean checkout. Lifecycle scripts stay off. */
export function installCommand(manager) {
  const name = manager?.name ?? manager;
  const major = manager?.major ?? null;
  if (name === "pnpm")
    return { program: binary("pnpm"), args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
  if (name === "yarn")
    return major !== null && major < 2
      ? { program: binary("yarn"), args: ["install", "--frozen-lockfile", "--ignore-scripts"] }
      : { program: binary("yarn"), args: ["install", "--immutable", "--mode=skip-build"] };
  if (name === "bun")
    return { program: binary("bun"), args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
  return {
    program: binary("npm"),
    args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
  };
}
