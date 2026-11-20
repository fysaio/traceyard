#!/usr/bin/env node
// Checks a running self-hosted Traceyard: health, database, the app shell and
// the API. Run it again with --existing after a restart.
//   node scripts/verify-selfhost.mjs http://localhost:8787 [revision] [--existing]
import assert from "node:assert/strict";

const [origin = "http://localhost:8787", revision] = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"));
const existing = process.argv.includes("--existing");
const deadline = Date.now() + 120_000;
let health;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${origin}/api/health`);
    if (response.ok) {
      health = (await response.json()).data;
      break;
    }
  } catch {
    // Still starting.
  }
  await new Promise((done) => setTimeout(done, 2000));
}
assert.ok(health, `${origin}/api/health did not answer within two minutes.`);
assert.equal(health.status, "ok");
assert.equal(health.checks.database.status, "ok");
if (revision) assert.equal(health.revision, revision);

const page = await fetch(`${origin}/investigations`, { headers: { accept: "text/html" } });
assert.equal(page.status, 200);
assert.match(await page.text(), /<div id="root">/);

// Database-backed API route: answers "sign in" rather than failing.
const repositories = await fetch(`${origin}/api/repositories`);
assert.equal(repositories.status, 403, `/api/repositories returned ${repositories.status}`);
assert.equal((await repositories.json()).error.code, "AUTHENTICATION_REQUIRED");

const scheduled = await fetch(`${origin}/__traceyard/scheduled`, { method: "POST" });
assert.equal(
  scheduled.status,
  404,
  "The scheduled-jobs endpoint must refuse callers without the secret.",
);
console.log(`Self-hosted Traceyard OK at ${origin}${existing ? " after restart" : ""}.`);
