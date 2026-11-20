import { expect, it } from "vitest";
// @ts-expect-error The runner executes plain JavaScript directly in Node.
import { summarizeCommandFailure } from "../../packages/core/src/failure-summary.mjs";

it("reports recognized causes across workspace test failures without uploading log payloads", () => {
  const message = summarizeCommandFailure(
    "\u001b[31mTest Files 1 failed | 14 passed\u001b[39m\nTest Files 11 failed | 8 passed\nCaused by: Error: supabaseUrl is required.\nAuthorization: Bearer private-fixture-value\nCustomer email: private@example.test",
    "test",
    1,
  );
  expect(message).toContain("12 test files failed");
  expect(message).toContain("Supabase test configuration is missing");
  expect(message).not.toMatch(/private|Authorization|Customer/);
  expect(message.length).toBeLessThanOrEqual(500);
});

it.each([
  ["install", "npm ERR! code ERESOLVE", "dependency versions"],
  ["install", "npm ci npm ERR! code EUSAGE", "lockfile"],
  ["build", "ERR_MODULE_NOT_FOUND", "module could not be loaded"],
  ["test", "GROQ_API_KEY_PRIMARY is missing", "test-only configuration"],
  ["test", "AssertionError: customer secret payload", "test assertion failed"],
  ["test", "unknown error with a private fixture value", "Open the command logs"],
])("summarizes %s failures safely", (phase, output, expected) => {
  expect(summarizeCommandFailure(output, phase, 1)).toContain(expected);
  expect(summarizeCommandFailure(output, phase, 1)).not.toContain("private fixture");
});
