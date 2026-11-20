import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { runLocalTest } from "../../core/src/index.mjs";
import { detectPackageManager, installCommand } from "../../core/src/package-manager.mjs";
import { isPytestFile } from "../../core/src/pytest.mjs";
import { summarizeCommandFailure } from "../../core/src/failure-summary.mjs";
import { ensureCommit } from "../../core/src/worktree.mjs";
import { BlockedError } from "./errors.mjs";
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
async function prepareJavaScript({ directory, repo, testPath, install, progress }) {
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
  let command = installCommand(manager);
  if (manager.name === "npm" && !(await exists(join(manager.installRoot, "package-lock.json"))))
    command = { ...command, args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"] };
  progress?.(`Installing dependencies with ${manager.name}...`);
  await runInstall(command, manager.installRoot, 10 * 60 * 1000);
  return "installed";
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

const cacheKey = (sha, testPath, testCase) =>
  sha +
  "-" +
  createHash("sha256")
    .update(JSON.stringify({ testPath, testCase: testCase ?? null, version: VERSION }))
    .digest("hex")
    .slice(0, 16);

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
  };
}

/**
 * Run one test, either in the working tree (commit = null) or at an exact
 * commit in a throwaway worktree. Results at a commit are cached in
 * `.traceyard/runs` so the same commit and test never run twice.
 */
export async function runTest({
  repo,
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
    const cached = await readJson(
      join(stateDir, "runs", cacheKey(sha, testPath, testCase) + ".json"),
    );
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
    output: report.output ?? "",
    dependencies,
    cached: false,
  };
  if (sha && result.status !== "BLOCKED") {
    await mkdir(join(stateDir, "runs"), { recursive: true });
    await writeFile(
      join(stateDir, "runs", cacheKey(sha, testPath, testCase) + ".json"),
      JSON.stringify({ ...result, recordedAt: new Date().toISOString() }, null, 2),
    );
  }
  return result;
}
