import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeDiagnostic } from "./test-report.mjs";

export const isPytestFile = (path) => /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(path);
const casePattern = /^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:\[[^\p{Cc}]{0,150}\])?$/u;

export function validPytestCase(value) {
  return typeof value === "string" && value.length <= 240 && casePattern.test(value);
}

export async function preparePytest(directory, file, test, plan) {
  if (plan.replayRecording || plan.flakeCandidate)
    return {
      reason:
        "This Pytest runner supports focused test execution. Replay and flakiness runs require Vitest.",
    };
  if (plan.testCase !== undefined && !validPytestCase(plan.testCase))
    return { reason: "Provide a valid Pytest case selector, without the file path." };
  for (const name of ["requirements-test.txt", "requirements.txt"]) {
    const path = join(directory, name);
    const stat = await lstat(path).catch(() => null);
    if (!stat) continue;
    const inside = relative(directory, await realpath(path));
    if (!stat.isFile() || stat.size > 128000 || inside.startsWith("..") || isAbsolute(inside))
      return { reason: "Pytest requires a regular requirements file in its package." };
    return {
      directory,
      file,
      requirements: path,
      runner: "pytest",
      command: {
        directory: test.packageDirectory,
        script: "pytest",
        testPath: test.path,
        ...(plan.testCase ? { testCase: plan.testCase } : {}),
      },
    };
  }
  return {
    reason:
      "Add requirements-test.txt or requirements.txt containing Pytest to this Python package.",
  };
}

export function pytestEnvironment(env, install = false) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        (install && /^(?:HTTPS?|NO|ALL)_PROXY$/i.test(key)) ||
        /^(?:PATH|SYSTEMROOT|HOME|USERPROFILE|TMPDIR|TMP|TEMP|CI|LANG|LC_ALL|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(
          key,
        ),
    ),
  );
}

export const pytestArgs = (file, testCase, output) => [
  "-I",
  fileURLToPath(new URL("./pytest-runner.py", import.meta.url)),
  file,
  testCase ?? "",
  output,
];

export function normalizePytestEvidence(data, exitCode, command) {
  if (data.reason) throw Error(sanitizeDiagnostic(data.reason, 500));
  const results = data.results;
  if (
    ![0, 1].includes(exitCode) ||
    !Array.isArray(results) ||
    !results.length ||
    (command.testCase && (results.length !== 1 || results[0]?.name !== command.testCase)) ||
    results.some(
      (item) =>
        typeof item?.name !== "string" || !["passed", "failed", "skipped"].includes(item.status),
    )
  )
    throw Error("Pytest did not report a complete outcome for the selected test.");
  const counts = { passed: 0, failed: 0, skipped: 0 };
  const failures = [];
  let truncated = false;
  for (const item of results) {
    counts[item.status]++;
    if (item.status !== "failed") continue;
    if (failures.length >= 8) {
      truncated = true;
      continue;
    }
    const diagnostic =
      typeof item.message === "string" ? item.message : "Pytest reported a failure.";
    if (diagnostic.length > 1500) truncated = true;
    failures.push({
      file: command.testPath,
      name: sanitizeDiagnostic(item.name, 250),
      message: sanitizeDiagnostic(diagnostic),
    });
  }
  if (counts.failed > 0 !== (exitCode === 1))
    throw Error("The Pytest process and retained outcomes disagree.");
  const status = counts.failed ? "FAILED" : counts.passed ? "SUCCEEDED" : "BLOCKED";
  return {
    status,
    counts,
    failures,
    truncated,
    message:
      "Pytest: " +
      counts.passed +
      " passed, " +
      counts.failed +
      " failed, " +
      counts.skipped +
      " skipped." +
      (status === "BLOCKED" ? " No passing executed case establishes success." : ""),
  };
}
