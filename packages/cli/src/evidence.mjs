// Map local CLI runs onto the versioned evidence envelope
// (shared/contracts/evidence.ts). Everything the CLI produces is
// LOCAL_PROVISIONAL and FOCUSED: one selected test on this machine, never a
// required-check, full-suite or merge-safety claim.

import { createHash, randomBytes } from "node:crypto";
import { buildEvidenceEnvelope, fingerprint } from "../../core/src/evidence.mjs";
import { VERSION } from "./version.mjs";

const SOURCE = "LOCAL_PROVISIONAL";
const SCOPE = "FOCUSED";

export const LOCAL_LIMITATION =
  "Local provisional evidence from this machine, not a hosted attestation.";
const focusedLimitation = (test) =>
  `Covers only ${label(test)}; it says nothing about other tests or whether the change is safe to merge.`;

/**
 * True for the two limitations every CLI envelope carries. They restate
 * `source: LOCAL_PROVISIONAL` and `scope: FOCUSED`, so compact agent
 * responses may leave them out and keep only the run-specific ones.
 */
export const isStandardLimitation = (text) =>
  text === LOCAL_LIMITATION || /^Covers only .+; it says nothing about other tests/.test(text);

const label = (test) => (test.case ? `${test.path}::${test.case}` : test.path);

/** The built-in verdict rules. Changes when the rules (or the CLI) change. */
export const policyFingerprint = () =>
  fingerprint({ policy: "traceyard-builtin-focused", version: 1, tool: VERSION });

function environmentFingerprint(runs) {
  return fingerprint({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    tool: VERSION,
    runners: runs.map((run) => run?.runner?.script ?? null),
    dependencies: runs.map((run) => run?.dependencies ?? null),
  });
}

export const newRequestId = () => "req_" + randomBytes(8).toString("hex");

/** Stable, non-reversible ID for a repository without a GitHub remote. */
export const repositoryId = (github, root) =>
  github
    ? "github:" + github
    : "local:" + createHash("sha256").update(root).digest("hex").slice(0, 16);

/** A selected test's outcome as one check. A run with no passing test checked nothing. */
function testStatus(run) {
  if (!run) return "NOT_RUN";
  if (run.status === "BLOCKED") return "BLOCKED";
  if (run.status === "FAILED") return "FAILED";
  return run.counts.passed > 0 ? "PASSED" : "SKIPPED";
}

function runState(run) {
  if (run.status === "BLOCKED") return "BLOCKED";
  if (run.status === "FAILED") return "FAILED";
  return "COMPLETED";
}

function runLimitations(run, role) {
  const notes = [];
  if (run.status === "BLOCKED") notes.push(`The ${role} run was blocked: ${run.message}`);
  else if (!run.counts.passed && run.status !== "FAILED")
    notes.push(`The ${role} run had no passing test, so nothing was checked.`);
  if (run.cached)
    notes.push(
      `The ${role} result was reused from an earlier run of the same commit and test${run.recordedAt ? ` (${run.recordedAt})` : ""}.`,
    );
  if (run.truncated) notes.push(`The ${role} failure list was truncated.`);
  return notes;
}

const evidenceIdFor = (...runs) =>
  runs.find((run) => run?.evidenceId)?.evidenceId ?? "ev_blocked_" + randomBytes(6).toString("hex");

/**
 * Envelope for `repro` (a commit) or `check` (the working tree).
 * `worktree` is `{ fingerprint, stale, complete }` for check: if the tree
 * changed while the test ran, the result is STALE rather than a pass or a failure.
 */
export function singleRunEnvelope({
  command,
  run,
  test,
  repository,
  requestId,
  worktree = null,
  next,
  startedAt,
  completedAt,
}) {
  const checks = [{ id: `test:${label(test)}`, status: testStatus(run), required: false }];
  const limitations = [LOCAL_LIMITATION, focusedLimitation(test), ...runLimitations(run, command)];
  let state = runState(run);
  if (worktree) {
    if (worktree.stale) {
      state = "STALE";
      limitations.push("The working tree changed while the test ran, so this result is stale.");
    }
    if (!worktree.complete)
      limitations.push(
        "The working-tree fingerprint does not cover every untracked file, so some edits may go undetected.",
      );
  }
  const evidenceId = evidenceIdFor(run);
  return buildEvidenceEnvelope({
    evidenceId,
    runId: run.evidenceId ?? evidenceId,
    requestId,
    repositoryId: repository,
    source: SOURCE,
    scope: SCOPE,
    state,
    revision: {
      commit: run.commit ?? null,
      worktreeFingerprint: worktree ? worktree.fingerprint : null,
      inputFingerprint: fingerprint({
        command,
        test: { path: test.path, case: test.case ?? null },
        commit: run.commit ?? null,
        worktree: worktree ? worktree.fingerprint : null,
      }),
      policyFingerprint: policyFingerprint(),
      environmentFingerprint: environmentFingerprint([run]),
    },
    checks,
    limitations,
    next,
    startedAt,
    completedAt,
  });
}

/**
 * Envelope for `verify`. Each rule the verdict depends on is its own check,
 * so a FIXED verdict is the only way to reach FOCUSED_PASS: the failure
 * reproduced before, the same test passes after, the commits differ, no new
 * skips, and no test inputs changed.
 */
export function verifyEnvelope({
  baseline,
  candidate,
  test,
  changedTests,
  repository,
  requestId,
  next,
  startedAt,
  completedAt,
}) {
  const reproduced =
    baseline.status === "BLOCKED"
      ? "BLOCKED"
      : baseline.status === "FAILED" && baseline.counts.failed > 0
        ? "PASSED"
        : "FAILED";
  const ran = Boolean(candidate) && reproduced === "PASSED";
  const checks = [
    { id: `reproduces-before:${label(test)}`, status: reproduced, required: false },
    {
      id: `passes-after:${label(test)}`,
      status: ran ? testStatus(candidate) : "NOT_RUN",
      required: false,
    },
    {
      id: "distinct-commits",
      status: !ran ? "NOT_RUN" : baseline.commit !== candidate.commit ? "PASSED" : "FAILED",
      required: false,
    },
    {
      id: "no-new-skips",
      status: !ran
        ? "NOT_RUN"
        : candidate.counts.skipped > baseline.counts.skipped
          ? "FAILED"
          : "PASSED",
      required: false,
    },
    {
      id: "test-inputs-unchanged",
      status: !ran ? "NOT_RUN" : changedTests.length ? "FAILED" : "PASSED",
      required: false,
    },
  ];
  const limitations = [
    LOCAL_LIMITATION,
    focusedLimitation(test),
    ...runLimitations(baseline, "baseline"),
    ...(candidate ? runLimitations(candidate, "candidate") : []),
  ];
  if (reproduced === "FAILED")
    limitations.push("The test did not fail at the baseline commit, so no fix can be shown.");
  if (ran && changedTests.length)
    limitations.push(
      `Test inputs changed between the commits: ${changedTests.slice(0, 5).join(", ")}${changedTests.length > 5 ? ", ..." : ""}.`,
    );
  let state = "COMPLETED";
  if (baseline.status === "BLOCKED" || candidate?.status === "BLOCKED") state = "BLOCKED";
  // Same commit on both sides proves nothing either way, even if the test fails.
  else if (ran && candidate.status === "FAILED" && baseline.commit !== candidate.commit)
    state = "FAILED";
  const evidenceId = evidenceIdFor(candidate, baseline);
  return buildEvidenceEnvelope({
    evidenceId,
    runId: (candidate ?? baseline).evidenceId ?? evidenceId,
    requestId,
    repositoryId: repository,
    source: SOURCE,
    scope: SCOPE,
    state,
    revision: {
      commit: (candidate ?? baseline).commit ?? null,
      worktreeFingerprint: null,
      inputFingerprint: fingerprint({
        command: "verify",
        test: { path: test.path, case: test.case ?? null },
        baseline: baseline.commit ?? null,
        candidate: candidate?.commit ?? null,
        changedTests: [...changedTests].sort(),
      }),
      policyFingerprint: policyFingerprint(),
      environmentFingerprint: environmentFingerprint([baseline, candidate]),
    },
    checks,
    limitations,
    next,
    startedAt,
    completedAt,
  });
}
