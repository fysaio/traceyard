import { isAbsolute, relative } from "node:path";
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
    const path = String(file.name ?? "");
    const fileName = (root && isAbsolute(path) ? relative(root, path) : path).split("\\").join("/");
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
