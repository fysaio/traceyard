import { readFile, realpath, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { summarizeCommandFailure } from "./failure-summary.mjs";

export function sanitizeDiagnostic(value, max = 1500) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/(?:sk-|tyk_|tyr_)[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/((?:api[_-]?key|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, max);
}
export function normalizeVitestReport(data, exitCode, root = "") {
  const failures = [];
  let omitted = false;
  for (const file of data.testResults ?? []) {
    const fileName =
      root && String(file.name ?? "").startsWith(root)
        ? relative(root, file.name).split("\\").join("/")
        : String(file.name ?? "");
    for (const test of file.assertionResults ?? [])
      if (test.status === "failed") {
        if (failures.length === 8) {
          omitted = true;
          continue;
        }
        const raw = (test.failureMessages ?? []).join("\n");
        if (raw.length > 1500) omitted = true;
        failures.push({
          file: fileName.slice(0, 240),
          name: sanitizeDiagnostic(test.fullName ?? test.title ?? "Unnamed assertion", 250),
          message: sanitizeDiagnostic(raw || "Assertion failed without a retained message."),
        });
      }
    if (
      file.status === "failed" &&
      !file.assertionResults?.some((t) => t.status === "failed") &&
      failures.length < 8
    )
      failures.push({
        file: fileName.slice(0, 240),
        name: "Suite initialization",
        message: sanitizeDiagnostic(file.message ?? "The suite could not initialize."),
      });
  }
  const counts = {
    passed: Math.max(0, Number(data.numPassedTests) || 0),
    failed: Math.max(0, Number(data.numFailedTests) || 0),
    skipped: Math.max(0, Number(data.numPendingTests) || 0),
  };
  const status =
    exitCode === 0 && counts.passed > 0 && !counts.failed && !failures.length
      ? "SUCCEEDED"
      : exitCode === 0
        ? "BLOCKED"
        : "FAILED";
  const text = failures.map((f) => f.message).join("\n");
  const configuration = /No Groq API keys configured|GROQ_API_KEY_PRIMARY is missing/.test(text)
    ? " A Groq configuration guard stopped execution; check whether a mocked suite reaches its provider mock before requesting real credentials."
    : /supabaseUrl is required|supabaseKey is required/.test(text)
      ? " Supabase initialized before the test mock; inspect fixture initialization."
      : "";
  return {
    status,
    counts,
    failures,
    truncated: omitted,
    message: `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped.${configuration}${status === "BLOCKED" ? " No passing executed test establishes success." : ""}`,
  };
}
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
export async function runTargetedTest(workspace, index, plan, env) {
  const started = Date.now(),
    selection = selectTest(index, plan.question, plan.testPath);
  const blocked = (message) => ({
    status: "BLOCKED",
    counts: { passed: 0, failed: 0, skipped: 0 },
    failures: [],
    truncated: false,
    message: sanitizeDiagnostic(message, 2000),
    durationMs: Date.now() - started,
    exitCode: null,
    nodeVersion: process.version,
    command: { directory: ".", script: "", testPath: null },
  });
  if (!selection.test)
    return blocked(
      selection.reason +
        (selection.candidates.length ? " Candidates: " + selection.candidates.join(", ") : ""),
    );
  const test = selection.test;
  if (!/^[A-Za-z0-9_./@-]+$/.test(test.path))
    return blocked("This test path is outside the supported command argument format.");
  const root = await realpath(workspace),
    directory = await realpath(resolve(root, test.packageDirectory)),
    file = await realpath(resolve(root, test.path));
  if (relative(root, directory).startsWith("..") || relative(directory, file).startsWith(".."))
    return blocked("The selected test escapes its package workspace.");
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const candidates = Object.entries(pkg.scripts ?? {}).filter(
    ([key, value]) => /^[A-Za-z0-9:_-]+$/.test(key) && /\bvitest\b/.test(String(value)),
  );
  const matching = candidates.filter(
    ([key]) =>
      key === "test" || test.path.toLowerCase().includes(key.replace(/^test:/, "").toLowerCase()),
  );
  const script =
    matching.length === 1 ? matching[0][0] : candidates.length === 1 ? candidates[0][0] : null;
  if (!script)
    return blocked(
      "A unique supported Vitest script could not be inferred for this test. Other runners remain available through ordinary repository checks.",
    );
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
          script,
          "--",
          relative(directory, file).split("\\").join("/"),
          "--reporter=json",
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
      result = normalizeVitestReport(JSON.parse(text), exitCode, root);
    } catch {
      return {
        ...blocked(
          timedOut
            ? "The focused test exceeded its time budget."
            : summarizeCommandFailure(tail, "test", exitCode ?? "interrupted"),
        ),
        exitCode,
      };
    }
    return {
      ...result,
      durationMs: Date.now() - started,
      exitCode,
      nodeVersion: process.version,
      command: { directory: test.packageDirectory, script, testPath: test.path },
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
