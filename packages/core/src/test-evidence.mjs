import { chown, readFile, realpath, mkdtemp, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { summarizeCommandFailure } from "./failure-summary.mjs";
import { relatedTests } from "./repository-index.mjs";
import { isPytestFile } from "./pytest.mjs";
import { adapterForFile, adapterForScript, runnerAdapters } from "./runners.mjs";
import { detectPackageManager, scriptCommand } from "./package-manager.mjs";

import { sanitizeDiagnostic, normalizeVitestReport } from "./test-report.mjs";
export { sanitizeDiagnostic, normalizeVitestReport };
export function selectTest(index, question, testPath) {
  const tests = index.files.filter((f) => f.isTest);
  if (testPath) {
    const test = tests.find((f) => f.path === testPath);
    return test
      ? { test }
      : {
          reason: "The selected test file is not present in this snapshot's index.",
          candidates: [],
        };
  }
  const words =
    question
      .toLowerCase()
      .match(/[a-z0-9_-]{3,}/g)
      ?.filter(
        (w) =>
          ![
            "investigate",
            "failing",
            "failed",
            "failure",
            "tests",
            "test",
            "debug",
            "please",
            "why",
            "the",
            "with",
            "and",
            "this",
          ].includes(w),
      ) ?? [];
  const ranked = tests
    .map((test) => ({
      test,
      score: words.reduce(
        (n, w) =>
          n +
          (test.path.toLowerCase().includes(w) ? 3 : 0) +
          (test.tests.some((t) => t.name.toLowerCase().includes(w)) ? 1 : 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.test.path.localeCompare(b.test.path));
  if (ranked.length === 1 || (ranked[0]?.score > 0 && ranked[0].score > (ranked[1]?.score ?? -1)))
    return { test: ranked[0].test };
  return {
    reason: tests.length
      ? "More than one test could match. Select one of the indexed test paths."
      : "No supported existing test was discovered.",
    candidates: ranked.slice(0, 8).map((x) => x.test.path),
  };
}
export async function prepareTargetedTest(workspace, index, plan) {
  const selection = selectTest(index, plan.question, plan.testPath);
  if (!selection.test)
    return {
      reason:
        selection.reason +
        (selection.candidates.length ? " Candidates: " + selection.candidates.join(", ") : ""),
    };
  const test = selection.test;
  if (!/^[A-Za-z0-9_./@-]+$/.test(test.path))
    return { reason: "This test path is outside the supported command argument format." };
  const root = await realpath(workspace);
  const directory = await realpath(resolve(root, test.packageDirectory));
  const file = await realpath(resolve(root, test.path));
  const packagePath = relative(root, directory);
  const filePath = relative(directory, file);
  if ([packagePath, filePath].some((path) => path.startsWith("..") || isAbsolute(path)))
    return { reason: "The selected test escapes its package workspace." };
  const fileAdapter = adapterForFile(test.path);
  if (fileAdapter?.prepare) return fileAdapter.prepare(directory, file, test, plan);
  if (plan.testCase !== undefined) return { reason: "A case selector requires a Pytest file." };
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  } catch {
    return { reason: "The selected test needs a readable package.json." };
  }

  const candidates = Object.entries(pkg.scripts ?? {}).flatMap(([name, command]) => {
    if (!/^[A-Za-z0-9:_-]+$/.test(name) || typeof command !== "string" || /[;&|\r\n]/.test(command))
      return [];
    const adapter = adapterForScript(command);
    return adapter ? [{ name, runner: adapter.name }] : [];
  });
  const matching = candidates.filter(({ name }) => {
    const kind = name.replace(/^test:/, "").toLowerCase();
    return name.startsWith("test:") && test.path.toLowerCase().split("/").includes(kind);
  });
  const selected =
    candidates.find(({ name }) => name === "test") ??
    (matching.length === 1 ? matching[0] : candidates.length === 1 ? candidates[0] : null);
  if (!selected)
    return {
      reason:
        "Select a test in an npm package with a clear Vitest or Jest script. Use a direct test command rather than a script that chains several checks.",
    };
  if (plan.replayRecording && !runnerAdapters[selected.runner].supports.replay)
    return { reason: "Isolated interaction replay requires Vitest." };
  return {
    root,
    directory,
    file,
    runner: selected.runner,
    command: { directory: test.packageDirectory, script: selected.name, testPath: test.path },
  };
}

/**
 * Options:
 * - `replay(root, command, plan)`: runs a recorded replay. Only the hosted runner
 *   provides it, because it needs Docker; without it replay plans are blocked.
 * - `packageManager`: force "npm" | "pnpm" | "yarn" | "bun" instead of detecting it.
 */
export async function runTargetedTest(workspace, index, plan, env, options = {}) {
  const started = Date.now();
  const blocked = (message, command = { directory: ".", script: "", testPath: null }) => ({
    status: "BLOCKED",
    counts: { passed: 0, failed: 0, skipped: 0 },
    failures: [],
    truncated: false,
    message: sanitizeDiagnostic(message, 2000),
    durationMs: Date.now() - started,
    exitCode: null,
    nodeVersion: process.version,
    command,
  });
  const prepared = await prepareTargetedTest(workspace, index, plan);
  if (prepared.reason) return blocked(prepared.reason);
  const { root, directory, file, runner, command } = prepared;
  if (plan.replayRecording)
    return options.replay
      ? options.replay(root, command, plan)
      : blocked("Recorded replay needs the isolated Traceyard runner.", command);
  const adapter = runnerAdapters[runner];
  const path = relative(directory, file).split("\\").join("/");
  const testArgument = path.startsWith("-") ? "./" + path : path;
  const temporary = await mkdtemp(join(tmpdir(), "traceyard-evidence-")),
    output = join(temporary, "report.json");
  // A hosted sandbox runs the test as a separate user, which must own the
  // directory its structured reporter writes to.
  const sandbox = options.sandbox ?? null;
  if (sandbox) await chown(temporary, sandbox.uid, sandbox.gid);
  let tail = "",
    timedOut = false;
  try {
    const isPytest = adapter.language === "python";
    if (isPytest && !env.TRACEYARD_PYTEST_PYTHON)
      return blocked("Install this package's Pytest dependencies before rerunning.", command);
    const runnerArgs = adapter.args({ testArgument, output, plan });
    const invocation = isPytest
      ? { program: env.TRACEYARD_PYTEST_PYTHON, args: runnerArgs }
      : scriptCommand(
          options.packageManager ?? (await detectPackageManager(root, directory)),
          command.script,
          runnerArgs,
        );
    let evidenceError;
    const exitCode = await new Promise((done, reject) => {
      const childEnv = adapter.environment ? adapter.environment(env) : env;
      const child = spawn(invocation.program, invocation.args, {
        cwd: directory,
        env: sandbox ? { ...childEnv, HOME: sandbox.home } : childEnv,
        ...(sandbox ? { uid: sandbox.uid, gid: sandbox.gid } : {}),
        shell: !isPytest && process.platform === "win32",
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const capture = (chunk) => {
        tail = (tail + chunk.toString()).slice(-16000);
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }, plan.timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (process.platform !== "win32")
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            /* No children remain. */
          }
        done(code);
      });
    });
    let result;
    const retainedOutput = sanitizeDiagnostic(tail.slice(-4000), 4000);
    try {
      // The reporter output is written by the test process; never follow a link
      // it planted in place of the file.
      const text = await readFile(output, {
        encoding: "utf8",
        flag: process.platform === "win32" ? "r" : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      });
      if (Buffer.byteLength(text) > 8_000_000)
        return blocked("The structured reporter exceeded the supported artifact size.");
      if (timedOut)
        return {
          ...blocked("The focused test exceeded its time budget.", command),
          output: retainedOutput,
        };
      const data = JSON.parse(text);
      try {
        result = adapter.normalize(data, exitCode, { root, directory, file, command });
      } catch (error) {
        if (isPytest) evidenceError = error.message;
        throw error;
      }
      if (result.blocked) return { ...blocked(result.blocked, command), output: retainedOutput };
    } catch {
      return {
        ...blocked(
          timedOut
            ? "The focused test exceeded its time budget."
            : (evidenceError ?? summarizeCommandFailure(tail, "test", exitCode ?? "interrupted")),
          command,
        ),
        output: retainedOutput,
        exitCode,
      };
    }
    return {
      ...result,
      output: retainedOutput,
      durationMs: Date.now() - started,
      exitCode,
      nodeVersion: process.version,
      command,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function runInvestigationPlan(workspace, index, plan, env, options = {}) {
  const started = Date.now(),
    selection = selectTest(index, plan.question, plan.testPath);
  if (!selection.test || isPytestFile(selection.test.path))
    return runTargetedTest(workspace, index, plan, env, options);
  const related = [
    ...new Set(
      (plan.changedFiles ?? []).flatMap((file) => relatedTests(index, file).map((t) => t.path)),
    ),
  ].filter((path) => path !== selection.test.path && !isPytestFile(path));
  const selected = [
    selection.test.path,
    ...related.slice(0, (plan.replayRecording ? 1 : (plan.maxTestFiles ?? 1)) - 1),
  ];
  const results = [];
  for (const path of selected) {
    const remaining = plan.timeoutMs - (Date.now() - started);
    if (remaining < 1000) break;
    const result = await runTargetedTest(
      workspace,
      index,
      { ...plan, testPath: path, timeoutMs: remaining },
      env,
      options,
    );
    results.push(result);
    if (result.status !== "SUCCEEDED") break;
  }
  const primary = results[0];
  if (!primary) return runTargetedTest(workspace, index, plan, env, options);
  const failed = results.some((r) => r.status === "FAILED"),
    blocked = results.some((r) => r.status === "BLOCKED");
  const counts = results.reduce(
    (sum, r) => ({
      passed: sum.passed + r.counts.passed,
      failed: sum.failed + r.counts.failed,
      skipped: sum.skipped + r.counts.skipped,
    }),
    { passed: 0, failed: 0, skipped: 0 },
  );
  const failures = results.flatMap((r) => r.failures),
    omittedTests = 1 + related.length - results.length;
  return {
    ...primary,
    status: failed ? "FAILED" : blocked ? "BLOCKED" : "SUCCEEDED",
    counts,
    failures: failures.slice(0, 8),
    exitCode: failed ? 1 : blocked ? null : 0,
    truncated: results.some((r) => r.truncated) || failures.length > 8,
    durationMs: Date.now() - started,
    message:
      `${counts.passed} passed, ${counts.failed} failed across ${results.length} test file(s). ${omittedTests ? `${omittedTests} related test file(s) remain outside this attempt.` : "Selected coverage completed."} ${results.find((r) => r.status !== "SUCCEEDED")?.message ?? ""}`.slice(
        0,
        2000,
      ),
    checks: results.map((r) => ({
      testPath: r.command.testPath ?? selection.test.path,
      status: r.status,
    })),
    coverage: { omittedTests },
  };
}
