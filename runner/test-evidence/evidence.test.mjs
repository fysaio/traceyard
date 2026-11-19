import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { compareTests, readJUnit, readReports } from "./evidence.mjs";
import { githubHistory } from "./history.mjs";

const { Response } = globalThis;
const oldSha = "a".repeat(40);
const sha = "b".repeat(40);
const repo = "fysaio/demo";
const lane = "linux-node22";
const meta = { version: 1, repository: repo, lane, sha, runId: 100, attempt: 2 };

test("JUnit keeps portable test identities and omits raw assertions and logs", () => {
  const xml = (file) =>
    '<testsuites><testsuite name="checkout" file="' +
    file +
    '">' +
    '<testcase name="subtotal &amp; tax" classname="cart"><failure message="secret=fixture-key">private output</failure></testcase>' +
    '<testcase name="recover"><error>unexpected runtime error</error></testcase>' +
    '<testcase name="offline"><skipped/></testcase><testcase name="empty cart"/>' +
    "<system-out>raw stdout</system-out></testsuite></testsuites>";
  const initial = readJUnit(xml("/home/user/app/tests/cart.test.ts"), "unit.xml", "/home/user/app");
  const moved = readJUnit(xml("C:\\repo\\tests\\cart.test.ts"), "unit.xml", "C:\\repo");
  assert.deepEqual(initial, moved);
  assert.deepEqual(
    initial.map(({ status }) => status),
    ["failed", "error", "skipped", "passed"],
  );
  assert.equal(initial[0].file, "tests/cart.test.ts");
  assert.equal(initial[0].name, "subtotal & tax");
  for (const value of ["fixture-key", "private output", "raw stdout"])
    assert(!JSON.stringify(initial).includes(value));
  assert.throws(() =>
    readJUnit('<!DOCTYPE testsuite SYSTEM "file:///etc/passwd"><testsuite/>', "x", "/repo"),
  );
  assert.throws(() => readJUnit("<testsuite><testcase", "x", "/repo"));
});

test("repeated identities keep observed execution counts and are excluded from history", async () => {
  const root = await mkdtemp(join(tmpdir(), "traceyard-junit-"));
  try {
    await writeFile(
      join(root, "unit.xml"),
      '<testsuite name="cart"><testcase name="estimate"/><testcase name="estimate"/></testsuite>',
    );
    const evidence = await readReports(root, root);
    assert.equal(evidence.observations.passed, 2);
    assert.equal(evidence.duplicates, 1);
    assert.equal(evidence.tests.length, 1);
    assert.equal(evidence.tests[0].status, "ambiguous");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commit and lane isolation distinguish intermittent tests from new and existing failures", () => {
  const cases = [
    { id: "new", status: "failed" },
    { id: "flaky", status: "passed" },
    { id: "known", status: "error" },
    { id: "untested", status: "failed" },
    { id: "skip", status: "skipped" },
    { id: "ambiguous", status: "ambiguous" },
  ];
  const actual = compareTests(cases, sha, [
    {
      report: {
        sha,
        runId: 40,
        tests: [
          { id: "flaky", status: "failed" },
          { id: "skip", status: "failed" },
        ],
      },
    },
    {
      baseline: true,
      report: {
        sha: oldSha,
        runId: 39,
        tests: [
          { id: "new", status: "passed" },
          { id: "known", status: "failed" },
        ],
      },
    },
    { report: { sha: oldSha, runId: 38, tests: [{ id: "untested", status: "passed" }] } },
  ]);
  assert.deepEqual(
    actual.findings.map(({ id, finding }) => [id, finding]),
    [
      ["new", "new-failure"],
      ["flaky", "intermittent"],
      ["known", "known-failure"],
      ["untested", "no-baseline"],
    ],
  );
  assert.equal(actual.counts.skipped, 1);
  assert.equal(actual.counts.ambiguous, 1);
});

test("GitHub history only uses earlier run snapshots and never sends its token to artifact storage", async () => {
  const testId = "f".repeat(64);
  const record = (runId, attempt, fields) => ({
    ...meta,
    runId,
    attempt,
    tests: [{ id: testId, status: "passed" }],
    ...fields,
  });
  const prior = new Map([
    [1, record(90, 1, { sha: oldSha })],
    [2, record(100, 1)],
    [4, record(85, 1, { lane: "windows-node22" })],
  ]);
  const consulted = [];
  const request = async (address, options) => {
    const url = new URL(address);
    const path = url.pathname.replace("/repos/" + repo + "/actions", "");
    if (url.hostname === "blob.example") {
      assert.equal(options.headers, undefined);
      const bytes = Buffer.from(JSON.stringify(prior.get(Number(path.slice(1)))));
      return new Response(zipSync({ "report.json": bytes }));
    }
    assert.equal(options.headers.Authorization, "Bearer readonly-test-token");
    if (path === "/runs/100") return Response.json({ workflow_id: 7, head_sha: sha });
    if (path === "/workflows/7/runs") {
      return Response.json({
        workflow_runs: url.searchParams.has("branch")
          ? [
              { id: 90, head_branch: "main", event: "push" },
              { id: 110, head_branch: "main", event: "push" },
            ]
          : [{ id: 100 }, { id: 85 }],
      });
    }
    const artifacts = {
      90: [{ id: 1, name: "traceyard-test-evidence-linux-node22-1" }],
      100: [
        { id: 3, name: "traceyard-test-evidence-linux-node22-2" },
        { id: 2, name: "traceyard-test-evidence-linux-node22-1" },
      ],
      85: [{ id: 4, name: "traceyard-test-evidence-linux-node22-1" }],
    };
    const [, run] = /^\/runs\/(\d+)\/artifacts$/.exec(path) ?? [];
    if (run) return Response.json({ artifacts: artifacts[run] });
    const [, artifact] = /^\/artifacts\/(\d+)\/zip$/.exec(path) ?? [];
    if (!artifact) throw Error("Unexpected endpoint.");
    consulted.push(Number(artifact));
    return new Response(null, {
      status: 302,
      headers: { location: "https://blob.example/" + artifact },
    });
  };
  const result = await githubHistory(meta, "main", "readonly-test-token", request);
  assert.equal(result.status, "partial");
  assert.deepEqual(
    result.snapshots.map((row) => [row.report.runId, row.baseline]),
    [
      [100, false],
      [90, true],
    ],
  );
  assert.deepEqual(consulted.sort(), [1, 2, 4]);
});
