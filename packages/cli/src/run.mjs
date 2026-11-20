import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { runLocalTest } from "../../core/src/index.mjs";
import { detectPackageManager, installCommand } from "../../core/src/package-manager.mjs";
import { isPytestFile } from "../../core/src/pytest.mjs";
import { summarizeCommandFailure } from "../../core/src/failure-summary.mjs";
import { ensureCommit } from "../../core/src/worktree.mjs";
import { BlockedError } from "./errors.mjs";
import { cleanOutput } from "./compact.mjs";
import { VERSION } from "./version.mjs";

const execFileAsync = promisify(execFile);
const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );
const lockfileNames = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Nearest directory at or above the test file that has a package.json, inside `root`. */
async function packageDirectory(root, testPath) {
  for (let directory = dirname(resolve(root, testPath)); ; directory = dirname(directory)) {
    if (relative(root, directory).startsWith("..")) return null;
    if (await exists(join(directory, "package.json"))) return directory;
    if (directory === root || dirname(directory) === directory) return null;
  }
}

const declaresDependencies = (pkg) =>
  ["dependencies", "devDependencies", "optionalDependencies"].some(
    (field) => pkg?.[field] && Object.keys(pkg[field]).length > 0,
  );

/** Same lockfiles and root package.json in both trees, so node_modules can be shared. */
async function sameDependencies(a, b) {
  for (const name of [...lockfileNames, "package.json"]) {
    const [left, right] = await Promise.all([
      readFile(join(a, name)).catch(() => null),
      readFile(join(b, name)).catch(() => null),
    ]);
    if ((left === null) !== (right === null)) return false;
    if (left && right && !left.equals(right)) return false;
  }
  return true;
}

function runInstall(command, cwd, timeoutMs) {
  return new Promise((done, fail) => {
    const child = spawn(command.program, command.args, {
      cwd,
      env: { ...process.env, CI: "true" },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const capture = (chunk) => (tail = (tail + chunk.toString()).slice(-16000));
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(new BlockedError(`Could not start ${command.program}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) done();
      else fail(new BlockedError(summarizeCommandFailure(tail, "install", signal ?? code)));
    });
  });
}

/**
 * Make dependencies available for a JavaScript test in `directory`.
 * - Already installed: use them.
 * - Exact-commit checkout with the same lockfile as the developer's clone: link
 *   the clone's node_modules instead of reinstalling.
 * - Otherwise install with lifecycle scripts off, when allowed.
 */
async function prepareJavaScript({ directory, repo, testPath, install, progress, cacheDir }) {
  const pkgDir = await packageDirectory(directory, testPath);
  if (!pkgDir) return "none";
  const manager = await detectPackageManager(directory, pkgDir);
  const roots = [...new Set([manager.installRoot, pkgDir])];
  const manifests = await Promise.all(roots.map((root) => readJson(join(root, "package.json"))));
  if (!manifests.some(declaresDependencies)) return "none";
  if (await exists(join(manager.installRoot, "node_modules"))) return "existing";
  if (directory !== repo) {
    const source = resolve(repo, relative(directory, manager.installRoot));
    if (
      (await exists(join(source, "node_modules"))) &&
      (await sameDependencies(source, manager.installRoot))
    ) {
      for (const root of roots) {
        const from = resolve(repo, relative(directory, root), "node_modules");
        const to = join(root, "node_modules");
        if ((await exists(from)) && !(await exists(to)))
          await symlink(from, to, process.platform === "win32" ? "junction" : "dir");
      }
      return "linked";
    }
  }
  if (!install)
    throw new BlockedError(
      `Dependencies are not installed in ${relative(repo, manager.installRoot) || "the repository root"}. Install them, or pass --install.`,
    );
  if (directory !== repo && cacheDir && roots.length === 1) {
    const cached = await cachedDependencies({
      manager,
      manifest: manifests[0],
      cacheDir,
      progress,
    });
    if (cached) {
      await symlink(
        cached.nodeModules,
        join(manager.installRoot, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      return cached.reused ? "cached" : "installed";
    }
  }
  let command = installCommand(manager);
  if (manager.name === "npm" && !(await exists(join(manager.installRoot, "package-lock.json"))))
    command = { ...command, args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"] };
  progress?.(`Installing dependencies with ${manager.name}...`);
  await runInstall(command, manager.installRoot, 10 * 60 * 1000);
  return "installed";
}

/** Per-user cache directory: TRACEYARD_CACHE_DIR, else the platform's cache location. */
export function cacheDirectory(env = process.env) {
  if (env.TRACEYARD_CACHE_DIR) return resolve(env.TRACEYARD_CACHE_DIR);
  if (process.platform === "win32")
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "traceyard", "Cache");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "traceyard");
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "traceyard");
}

const KEEP_DEPENDENCY_SETS = 5;
const COMPLETE = ".traceyard-complete";

/**
 * Install dependencies once per lockfile and reuse them for every exact-commit
 * run with the same lockfile. Keyed by package manager, lockfile, package.json,
 * Node major version and platform. Only for single-package projects whose
 * dependencies come from a registry: workspaces and file:/link: dependencies
 * need the full checkout, so they install in place.
 */
async function cachedDependencies({ manager, manifest, cacheDir, progress }) {
  if (!manifest || manifest.workspaces) return null;
  const local = ["dependencies", "devDependencies", "optionalDependencies"].some((field) =>
    Object.values(manifest[field] ?? {}).some((spec) =>
      /^(?:file:|link:|workspace:|portal:|\.{0,2}\/)/.test(String(spec)),
    ),
  );
  if (local || (await exists(join(manager.installRoot, ".yarnrc.yml")))) return null;
  let lockfile = null;
  for (const name of lockfileNames)
    if (await exists(join(manager.installRoot, name))) {
      lockfile = name;
      break;
    }
  if (!lockfile) return null;
  const hash = createHash("sha256");
  hash.update(manager.name + "\0" + process.version.split(".")[0] + "\0" + process.platform);
  hash.update("\0" + process.arch);
  for (const name of [lockfile, "package.json", ".npmrc"])
    hash.update(
      "\0" +
        name +
        "\0" +
        ((await readFile(join(manager.installRoot, name)).catch(() => "")) || ""),
    );
  const key = hash.digest("hex").slice(0, 20);
  const root = join(cacheDir, "deps", key);
  const nodeModules = join(root, "node_modules");
  if (await exists(join(nodeModules, COMPLETE))) {
    const now = new Date();
    await utimes(root, now, now).catch(() => {});
    return { nodeModules, reused: true };
  }
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const name of [lockfile, "package.json", ".npmrc"])
    if (await exists(join(manager.installRoot, name)))
      await copyFile(join(manager.installRoot, name), join(root, name));
  let command = installCommand(manager);
  if (
    manager.name === "npm" &&
    lockfile !== "package-lock.json" &&
    lockfile !== "npm-shrinkwrap.json"
  )
    command = { ...command, args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"] };
  progress?.(`Installing dependencies with ${manager.name} (cached for next time)...`);
  try {
    await runInstall(command, root, 10 * 60 * 1000);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  if (!(await exists(nodeModules))) {
    await rm(root, { recursive: true, force: true });
    return null;
  }
  await writeFile(join(nodeModules, COMPLETE), new Date().toISOString() + "\n");
  await pruneDependencyCache(join(cacheDir, "deps"), key);
  return { nodeModules, reused: false };
}

/** Keep the most recently used dependency sets; delete the rest. */
async function pruneDependencyCache(depsDir, keep) {
  const entries = await readdir(depsDir).catch(() => []);
  const dated = [];
  for (const name of entries)
    dated.push({ name, time: (await stat(join(depsDir, name)).catch(() => null))?.mtimeMs ?? 0 });
  dated.sort((a, b) => b.time - a.time);
  for (const { name } of dated.slice(KEEP_DEPENDENCY_SETS))
    if (name !== keep) await rm(join(depsDir, name), { recursive: true, force: true });
}

async function canRunPytest(python) {
  try {
    await execFileAsync(python, ["-c", "import pytest"], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** A Python interpreter that can import pytest: TRACEYARD_PYTHON, a repo virtualenv, then PATH. */
async function findPython(repo, env) {
  const windows = process.platform === "win32";
  const candidates = [
    env.TRACEYARD_PYTHON,
    env.VIRTUAL_ENV && join(env.VIRTUAL_ENV, windows ? "Scripts/python.exe" : "bin/python"),
    ...[".venv", "venv"].map((name) =>
      join(repo, name, windows ? "Scripts/python.exe" : "bin/python"),
    ),
    windows ? "python" : "python3",
    "python",
  ].filter(Boolean);
  for (const candidate of candidates) if (await canRunPytest(candidate)) return candidate;
  throw new BlockedError(
    "No Python with pytest was found. Activate your virtualenv, or set TRACEYARD_PYTHON to an interpreter that has pytest installed.",
  );
}

/** Evidence ID for a run at a commit. The same commit and test always map to the same ID. */
const commitEvidenceId = (sha, testPath, testCase) =>
  "ev_" +
  sha.slice(0, 12) +
  "_" +
  createHash("sha256")
    .update(JSON.stringify({ sha, testPath, testCase: testCase ?? null, version: VERSION }))
    .digest("hex")
    .slice(0, 12);

/** Working-tree runs can't be cached (the files change), so each gets its own ID. */
const workingTreeEvidenceId = () =>
  "ev_wt_" + Date.now().toString(36) + "_" + randomBytes(3).toString("hex");

export const EVIDENCE_ID = /^ev_[a-z0-9]+_[a-z0-9_]+$/;
const KEEP_WORKING_TREE_RUNS = 20;

/** Load a recorded run by its evidence ID. */
export async function readEvidence(stateDir, evidenceId) {
  if (!EVIDENCE_ID.test(evidenceId ?? "")) return null;
  return readJson(join(stateDir, "runs", evidenceId + ".json"));
}

/** Recorded runs, newest first. */
export async function listEvidence(stateDir, limit = 8) {
  const dir = join(stateDir, "runs");
  const names = (await readdir(dir).catch(() => [])).filter((n) => /^ev_.*\.json$/.test(n));
  const runs = [];
  for (const name of names) {
    const run = await readJson(join(dir, name));
    if (run?.evidenceId) runs.push(run);
  }
  runs.sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)));
  return runs.slice(0, limit);
}

async function pruneWorkingTreeRuns(dir) {
  const names = (await readdir(dir).catch(() => []))
    .filter((n) => n.startsWith("ev_wt_"))
    .sort()
    .reverse();
  for (const name of names.slice(KEEP_WORKING_TREE_RUNS))
    await rm(join(dir, name), { force: true });
}

function blockedRun(commit, message, started) {
  return {
    commit,
    status: "BLOCKED",
    counts: { passed: 0, failed: 0, skipped: 0 },
    failures: [],
    truncated: false,
    message,
    durationMs: Date.now() - started,
    exitCode: null,
    runner: null,
    output: "",
    dependencies: "none",
    cached: false,
    evidenceId: null,
  };
}

/**
 * Run one test, either in the working tree (commit = null) or at an exact
 * commit in a throwaway worktree. Results at a commit are cached in
 * `.traceyard/runs` so the same commit and test never run twice.
 */
export async function runTest({
  repo,
  cacheDir = cacheDirectory(),
  commit,
  testPath,
  testCase,
  install = false,
  fetch = false,
  fresh = false,
  timeoutMs = 180000,
  stateDir,
  progress,
  env = process.env,
}) {
  const started = Date.now();
  let sha = null;
  if (commit) {
    try {
      sha = await ensureCommit(repo, commit, { fetch });
    } catch (error) {
      throw new BlockedError(error.message);
    }
    const cached = await readEvidence(stateDir, commitEvidenceId(sha, testPath, testCase));
    if (cached && !fresh) return { ...cached, cached: true };
  }
  const python = isPytestFile(testPath);
  let dependencies = "none";
  const runEnv = { ...env, CI: env.CI ?? "true" };
  try {
    if (python) runEnv.TRACEYARD_PYTEST_PYTHON = await findPython(repo, env);
    else if (!commit)
      dependencies = await prepareJavaScript({
        directory: repo,
        repo,
        testPath,
        install,
        progress,
      });
  } catch (error) {
    if (error instanceof BlockedError) return blockedRun(sha, error.message, started);
    throw error;
  }
  progress?.(`Running ${testPath}${sha ? " at " + sha.slice(0, 12) : " in your working tree"}...`);
  let report;
  try {
    report = await runLocalTest({
      repo,
      commit: sha ?? undefined,
      testPath,
      testCase,
      timeoutMs,
      env: runEnv,
      beforeRun:
        commit && !python
          ? async (directory) => {
              dependencies = await prepareJavaScript({
                directory,
                repo,
                testPath,
                install: true,
                progress,
                cacheDir,
              });
            }
          : undefined,
    });
  } catch (error) {
    if (error instanceof BlockedError) return blockedRun(sha, error.message, started);
    throw error;
  }
  const missing = /not present in this snapshot's index/.test(report.message);
  const result = {
    commit: sha,
    status: report.status,
    counts: report.counts,
    failures: report.failures,
    truncated: report.truncated,
    message: missing
      ? `${testPath} isn't a test file Traceyard can find ${sha ? "at " + sha.slice(0, 12) : "in your working tree"}. Check the path; it must be a Vitest, Jest or Pytest test file.`
      : report.message,
    durationMs: report.durationMs,
    exitCode: report.exitCode,
    runner: report.command?.script
      ? { script: report.command.script, directory: report.command.directory }
      : null,
    output: cleanOutput(report.output ?? "", repo),
    dependencies,
    cached: false,
    evidenceId: null,
  };
  if (result.status !== "BLOCKED") {
    // Every run that executed is kept as evidence, so agents can read the full
    // log later in bounded slices instead of receiving it up front.
    result.evidenceId = sha ? commitEvidenceId(sha, testPath, testCase) : workingTreeEvidenceId();
    const dir = join(stateDir, "runs");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, result.evidenceId + ".json"),
      JSON.stringify(
        {
          ...result,
          test: { path: testPath, case: testCase ?? null },
          recordedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    if (!sha) await pruneWorkingTreeRuns(dir);
  }
  return result;
}
