import { stripVTControlCharacters } from "node:util";

// Upload only recognized diagnostic categories and counts, never raw application
// output: logs can contain credentials, customer data, and assertion snapshots.
export function summarizeCommandFailure(output, phase, result) {
  const text = stripVTControlCharacters(output);
  const label =
    { install: "Dependency installation", build: "Build", test: "Tests" }[phase] ?? "Command";
  const details = [];
  const counts = [...text.matchAll(/Test Files\s+(\d+) failed/g)];
  if (counts.length) {
    const count = counts.reduce((total, match) => total + Number(match[1]), 0);
    details.push(`${count} test file${count === 1 ? "" : "s"} failed.`);
  }
  if (/supabaseUrl is required|supabaseKey is required/i.test(text))
    details.push(
      "Supabase test configuration is missing. Configure the test environment or fully mock the Supabase client.",
    );
  if (/No Groq API keys configured|GROQ_API_KEY_PRIMARY is missing/.test(text))
    details.push(
      "Groq configuration is missing. Mocked tests need test-only configuration; live tests need a configured provider.",
    );
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(text))
    details.push(
      "A required module could not be loaded. Check installed dependencies and import paths.",
    );
  if (/ERESOLVE/.test(text))
    details.push(
      "npm could not resolve the dependency versions. Check package.json and the lockfile.",
    );
  if (/EUSAGE/.test(text) && /npm ci/.test(text))
    details.push("npm ci rejected the lockfile. Synchronize package.json and package-lock.json.");
  if (!details.length && /AssertionError|⎯+ Failed Tests|ERR_ASSERTION/.test(text))
    details.push("A test assertion failed.");
  return `${label} failed (${result}). ${details.join(" ")}${details.length ? " " : ""}Open the command logs for details.`.slice(
    0,
    500,
  );
}
