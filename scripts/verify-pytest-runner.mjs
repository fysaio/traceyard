import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = resolve(process.argv[2] ?? "agent/cli.mjs");
const root = await mkdtemp(join(tmpdir(), "traceyard-python-"));
const invocation = "req_" + "b".repeat(32);
const investigation = "inv_" + "a".repeat(32);
const path = "services/store/tests/test_checkout.py";
const testCase = "TestCheckout::test_total[wallet]";
const reports = [];
const indexed = [];
let commit;
let selected = testCase;
let origin;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, origin);
  response.setHeader("content-type", "application/json");
  if (request.method === "GET" && url.pathname === "/oidc") {
    assert.equal(url.searchParams.get("audience"), origin);
    response.end(JSON.stringify({ value: "fixture-oidc-response" }));
    return;
  }
  assert.equal(request.headers.authorization, "Bearer fixture-oidc-response");
  if (request.method === "GET") {
    assert.equal(url.searchParams.get("request"), invocation);
    response.end(
      JSON.stringify({
        data: {
          config: { directory: ".", startScript: "", port: 3000 },
          cases: [],
          capabilities: { repositoryIndex: true },
          investigation: {
            investigationId: investigation,
            requestId: invocation,
            question: "Reproduce the wallet total",
            testPath: path,
            testCase: selected,
            commit,
            timeoutMs: 20000,
          },
        },
      }),
    );
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const posted = JSON.parse(raw);
  if (url.pathname.endsWith("/report")) reports.push(posted);
  if (url.pathname.endsWith("/repository/index") && posted.files) indexed.push(...posted.files);
  response.end(JSON.stringify({ data: { received: true } }));
});

try {
  await new Promise((ready, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  origin = "http://127.0.0.1:" + server.address().port;
  const git = (...args) => run("git", args, { cwd: root });
  await git("init", "-q");
  await git("config", "user.name", "Traceyard fixture");
  await git("config", "user.email", "traceyard@example.invalid");
  const app = join(root, "services", "store");
  await mkdir(join(app, "tests"), { recursive: true });
  await run("python3", [
    "-m",
    "pip",
    "--disable-pip-version-check",
    "download",
    "--only-binary=:all:",
    "--dest",
    join(app, "wheels"),
    "pytest==8.4.2",
  ]);
  await writeFile(
    join(app, "requirements-test.txt"),
    "--no-index\n--find-links ./wheels\npytest==8.4.2\n",
  );
  await writeFile(join(app, "pytest.ini"), "[pytest]\naddopts = tests/test_other.py\n");
  await writeFile(
    join(app, "tests", "test_other.py"),
    "def test_unselected_file():\n    assert False\n",
  );
  await writeFile(
    join(root, path),
    `import os
import pytest
from checkout import total

class TestCheckout:
    @pytest.mark.parametrize("method", ["card", "wallet"])
    def test_total(self, method):
        assert method == "wallet", "a sibling case was executed"
        assert "ACTIONS_ID_TOKEN_REQUEST_TOKEN" not in os.environ
        assert "TRACEYARD_GITHUB_FETCH_TOKEN" not in os.environ
        assert "DEMO_USER_TOKEN" not in os.environ
        assert total() == 42
`,
  );
  const addRevision = async (total) => {
    await writeFile(join(app, "checkout.py"), "def total():\n    return " + total + "\n");
    await git("add", ".");
    await git("commit", "-qm", "Checkout total " + total);
    return (await git("rev-parse", "HEAD")).stdout.trim();
  };
  const baseline = await addRevision(41);
  const candidate = await addRevision(42);
  const check = async (revision, expectedStatus, expectedCase, expectedCounts) => {
    commit = revision;
    selected = expectedCase;
    const options = {
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        GITHUB_RUN_ID: "1234",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_STEP_SUMMARY: join(root, "job-summary.md"),
        TRACEYARD_ORIGIN: origin,
        TRACEYARD_RUN_REQUEST: invocation,
        ACTIONS_ID_TOKEN_REQUEST_URL: origin + "/oidc",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-oidc-request-secret",
        TRACEYARD_GITHUB_FETCH_TOKEN: "fixture-github-token",
        DEMO_USER_TOKEN: "fixture-user-token",
      },
    };
    const result = await run(process.execPath, [cli, "run", root], options).catch((error) => error);
    assert.equal(
      result.code ?? 0,
      expectedStatus === "SUCCEEDED" ? 0 : 1,
      result.stdout + result.stderr,
    );
    const report = reports.at(-1);
    assert.equal(
      report?.status,
      expectedStatus,
      [JSON.stringify(report), result.stdout, result.stderr].join("\n"),
    );
    assert.equal(report.commit, revision);
    assert.equal(report.command.testPath, path);
    assert.equal(report.command.testCase, expectedCase);
    assert.deepEqual(report.counts, expectedCounts);
    assert(!JSON.stringify(report).includes("fixture-oidc-request-secret"));
    if (expectedStatus === "FAILED") {
      assert.equal(report.failures[0].name, expectedCase);
      assert.match(report.failures[0].message, /assert 41 == 42/);
    }
    console.log(
      expectedStatus + " at " + revision.slice(0, 12) + " for " + report.command.testCase,
    );
  };
  await check(baseline, "FAILED", testCase, { passed: 0, failed: 1, skipped: 0 });
  await check(candidate, "SUCCEEDED", testCase, { passed: 1, failed: 0, skipped: 0 });
  await check(candidate, "BLOCKED", "TestCheckout::test_total[cash]", {
    passed: 0,
    failed: 0,
    skipped: 0,
  });
  assert.equal(reports.length, 3);
  assert(
    indexed.some(
      (entry) => entry.path === path && entry.isTest && entry.packageDirectory === "services/store",
    ),
  );
} finally {
  server.closeAllConnections();
  if (server.listening) await promisify(server.close.bind(server))();
  await rm(root, { recursive: true, force: true });
}
