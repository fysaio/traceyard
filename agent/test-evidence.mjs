import { readFile, realpath, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { summarizeCommandFailure } from "./failure-summary.mjs";
import { relatedTests } from "./repository-index.mjs";
import { replayVitest } from "./replay-runner.mjs";

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
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  } catch {
    return { reason: "The selected test needs a readable package.json." };
  }

  const candidates = Object.entries(pkg.scripts ?? {}).flatMap(([name, command]) => {
    if (!/^[A-Za-z0-9:_-]+$/.test(name) || typeof command !== "string" || /[;&|\r\n]/.test(command))
      return [];
    const match = command
      .trim()
      .match(
        /^(?:vitest|jest)(?=\s|$)|^node\s+["']?[^\r\n]*?[\\/](vitest\.mjs|jest\.js)["']?(?=\s|$)/,
      );
    if (!match) return [];
    return [{ name, runner: match[0] === "jest" || match[1] === "jest.js" ? "jest" : "vitest" }];
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
  if (plan.replayRecording && selected.runner !== "vitest")
    return { reason: "Isolated interaction replay requires Vitest." };
  return {
    root,
    directory,
    file,
    runner: selected.runner,
    command: { directory: test.packageDirectory, script: selected.name, testPath: test.path },
  };
}

export async function runTargetedTest(workspace, index, plan, env) {
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
  if (plan.replayRecording) return replayVitest(root, command, plan);
  const path = relative(directory, file).split("\\").join("/");
  const testArgument = path.startsWith("-") ? "./" + path : path;
  const temporary = await mkdtemp(join(tmpdir(), "traceyard-evidence-")),
    output = join(temporary, "report.json");
  let tail = "",
    timedOut = false;
  try {
    const exitCode = await new Promise((done, reject) => {
      const child = spawn(
        process.platform === "win32" ? "npm.cmd" : "npm",
        [
          "run",
          command.script,
          "--",
          ...(runner === "jest"
            ? ["--ci", "--watch=false", "--watchAll=false", "--runTestsByPath", "--json"]
            : ["--run", "--reporter=json"]),
          testArgument,
          "--outputFile=" + output,
        ],
        {
          cwd: directory,
          env,
          shell: process.platform === "win32",
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
    try {
      const text = await readFile(output, "utf8");
      if (Buffer.byteLength(text) > 8_000_000)
        return blocked("The structured reporter exceeded the supported artifact size.");
      if (timedOut) return blocked("The focused test exceeded its time budget.", command);
      const data = JSON.parse(text);
      if (!Array.isArray(data.testResults) || !data.testResults.length)
        return blocked("The test runner did not report a result for the selected file.", command);
      if (data.testResults.some(({ name }) => relative(file, resolve(directory, String(name)))))
        return blocked("The test script reported files outside the selected test.", command);
      result = normalizeVitestReport(data, exitCode, root);
    } catch {
      return {
        ...blocked(
          timedOut
            ? "The focused test exceeded its time budget."
            : summarizeCommandFailure(tail, "test", exitCode ?? "interrupted"),
          command,
        ),
        exitCode,
      };
    }
    return {
      ...result,
      durationMs: Date.now() - started,
      exitCode,
      nodeVersion: process.version,
      command,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function runInvestigationPlan(workspace, index, plan, env) {
  const started = Date.now(),
    selection = selectTest(index, plan.question, plan.testPath);
  if (!selection.test) return runTargetedTest(workspace, index, plan, env);
  const related = [
    ...new Set(
      (plan.changedFiles ?? []).flatMap((file) => relatedTests(index, file).map((t) => t.path)),
    ),
  ].filter((path) => path !== selection.test.path);
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
    );
    results.push(result);
    if (result.status !== "SUCCEEDED") break;
  }
  const primary = results[0];
  if (!primary) return runTargetedTest(workspace, index, plan, env);
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
