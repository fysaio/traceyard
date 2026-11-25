// Verdicts and exit codes for every command. Pure functions, so the rules are
// easy to read and test. Exit codes are part of the public contract (docs/CLI.md).

export const EXIT = {
  OK: 0, // REPRODUCED, PASSED, FIXED
  FAILING: 1, // FAILING, STILL_FAILING, UNVERIFIED
  REVIEW: 2, // NOT_REPRODUCED, NEEDS_REVIEW, INCONCLUSIVE
  BLOCKED: 3, // BLOCKED: the test could not run here
  USAGE: 64, // bad arguments
  INTERNAL: 70, // a bug in Traceyard
};

export const exitCodeFor = (verdict) =>
  ({
    REPRODUCED: EXIT.OK,
    PASSED: EXIT.OK,
    FIXED: EXIT.OK,
    AVAILABLE: EXIT.OK,
    FAILING: EXIT.FAILING,
    STILL_FAILING: EXIT.FAILING,
    UNVERIFIED: EXIT.FAILING,
    NOT_REPRODUCED: EXIT.REVIEW,
    NEEDS_REVIEW: EXIT.REVIEW,
    INCONCLUSIVE: EXIT.REVIEW,
    BLOCKED: EXIT.BLOCKED,
    ERROR: EXIT.USAGE,
  })[verdict] ?? EXIT.INTERNAL;

const short = (sha) => (sha ? sha.slice(0, 12) : "your working tree");

/** Tests, fixtures, snapshots and Pytest configuration: edits here can make a test pass without a fix. */
export const isTestInput = (path) =>
  /\.(?:test|spec|fixture)\.[cm]?[jt]sx?$|(?:^|\/)(?:__(?:tests|fixtures|snapshots|mocks)__|tests?|fixtures?)\/|\.snap$/i.test(
    path,
  ) ||
  /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.py|conftest\.py|pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|requirements[^/]*\.txt)$/.test(
    path,
  ) ||
  /(?:^|\/)(?:vitest|vite|jest)\.config\.[cm]?[jt]s$/.test(path);

export function reproVerdict(run, testPath, { fromCi = false } = {}) {
  if (run.status === "BLOCKED")
    return {
      verdict: "BLOCKED",
      summary: run.message,
      next: "Fix what blocked the run, then rerun the same command.",
    };
  if (run.status === "FAILED")
    return {
      verdict: "REPRODUCED",
      summary: `${testPath} fails at ${short(run.commit)}: ${run.counts.failed} failed, ${run.counts.passed} passed.`,
      next: "Fix the code, not the test. Run `traceyard check` after each attempt, then commit and run `traceyard verify`.",
    };
  return {
    verdict: "NOT_REPRODUCED",
    summary: `${testPath} passed at ${short(run.commit)}, so the failure did not reproduce.`,
    next: fromCi
      ? "This is the commit CI tested, so the failure may depend on CI's environment or on another test. Check the job log, then try the failing test CI named."
      : "Check the commit and test file. If CI failed, pass the job link with --from so Traceyard uses the commit CI tested.",
  };
}

export function checkVerdict(run, testPath) {
  if (run.status === "BLOCKED")
    return {
      verdict: "BLOCKED",
      summary: run.message,
      next: "Fix what blocked the run, then rerun `traceyard check`.",
    };
  if (run.status === "FAILED")
    return {
      verdict: "FAILING",
      summary: `${testPath} still fails in ${short(run.commit)}: ${run.counts.failed} failed, ${run.counts.passed} passed.`,
      next: "Read the first failure, change the code, and run `traceyard check` again.",
    };
  if (!run.counts.passed)
    return {
      verdict: "BLOCKED",
      summary: `${testPath} ran no passing tests, so nothing was checked.`,
      next: "Make sure the test is not skipped, then rerun `traceyard check`.",
    };
  return {
    verdict: "PASSED",
    summary: `${testPath} passes in ${short(run.commit)}: ${run.counts.passed} passed.`,
    next: "Commit the fix and run `traceyard verify` to record a receipt.",
  };
}

/**
 * Compare a baseline (failing commit) and a candidate (fix commit). Mirrors the
 * hosted verification: a pass only counts as FIXED when the failure reproduced,
 * the same test passed, nothing was skipped away and no test inputs changed.
 */
export function verifyVerdict({ baseline, candidate, testPath, changedFiles }) {
  const changedTests = changedFiles.filter(isTestInput);
  const result = (verdict, summary, next) => ({ verdict, summary, next, changedTests });
  if (baseline.status === "BLOCKED")
    return result(
      "BLOCKED",
      "The failing commit could not run: " + baseline.message,
      "Fix what blocked the run, then rerun `traceyard verify`.",
    );
  if (baseline.status !== "FAILED" || !baseline.counts.failed)
    return result(
      "NOT_REPRODUCED",
      `${testPath} passed at the failing commit ${short(baseline.commit)}, so there is no failure to verify a fix against.`,
      "Check the --before commit. Use the commit CI tested, or pass the job link to `traceyard repro --from`.",
    );
  if (candidate.status === "BLOCKED")
    return result(
      "BLOCKED",
      "The fix commit could not run: " + candidate.message,
      "Fix what blocked the run, then rerun `traceyard verify`.",
    );
  if (baseline.commit === candidate.commit)
    return result(
      "INCONCLUSIVE",
      "The failing commit and the fix commit are the same.",
      "Commit the fix, then run `traceyard verify` again.",
    );
  if (candidate.status === "FAILED") {
    const same =
      candidate.failures[0]?.name && candidate.failures[0].name === baseline.failures[0]?.name;
    return result(
      "STILL_FAILING",
      same
        ? `${testPath} still fails at ${short(candidate.commit)} with the same test case.`
        : `${testPath} fails at ${short(candidate.commit)} with a different test case.`,
      "Read the first failure, change the code, and run `traceyard check` before verifying again.",
    );
  }
  if (!candidate.counts.passed || candidate.counts.skipped > baseline.counts.skipped)
    return result(
      "INCONCLUSIVE",
      `${testPath} did not fail at ${short(candidate.commit)}, but ${candidate.counts.skipped - baseline.counts.skipped} more test(s) were skipped, so the pass doesn't prove a fix.`,
      "Remove the skips and verify again.",
    );
  if (changedTests.length)
    return result(
      "NEEDS_REVIEW",
      `${testPath} passes at ${short(candidate.commit)}, but test files or fixtures changed between the commits.`,
      "Review the changed test files before accepting the fix. A fix should change code, not the test.",
    );
  return result(
    "FIXED",
    `${testPath} failed at ${short(baseline.commit)} and passes at ${short(candidate.commit)}, with no test files changed.`,
    "Open a pull request and attach the receipt.",
  );
}

/**
 * The merge gate. FIXED only for an intact receipt whose verdict is FIXED and
 * whose fix commit is exactly HEAD; anything else keeps the claim unproven.
 */
export function guardVerdict({ receipt, intact, head }) {
  const verify = "Run `traceyard verify` on the fix commit, then run `traceyard guard` again.";
  if (!receipt)
    return {
      verdict: "UNVERIFIED",
      summary: "No receipt yet, so nothing proves this commit fixes a failing test.",
      next: "Run `traceyard repro <test>` on the failing commit, fix the code, commit, then `traceyard verify`.",
    };
  if (!intact)
    return {
      verdict: "NEEDS_REVIEW",
      summary: `Receipt ${receipt.id} was edited after it was written; its digest doesn't match.`,
      next: verify,
    };
  if (receipt.verdict !== "FIXED")
    return {
      verdict: receipt.verdict === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : "UNVERIFIED",
      summary: `The latest receipt (${receipt.id}) says ${receipt.verdict}, not FIXED: ${receipt.summary}`,
      next:
        receipt.verdict === "NEEDS_REVIEW"
          ? "A person should review the changed test files before this merges."
          : verify,
    };
  // Receipts written since the evidence envelope must agree with it. Older
  // receipts have none and are judged on their verdict alone.
  const envelope = receipt.evidenceEnvelope;
  if (
    envelope &&
    (envelope.claim !== "FOCUSED_PASS" ||
      envelope.state !== "COMPLETED" ||
      envelope.revision?.commit !== receipt.candidate?.commit)
  )
    return {
      verdict: "NEEDS_REVIEW",
      summary: `Receipt ${receipt.id} says FIXED, but its evidence claims ${envelope.claim ?? "nothing"} for ${short(envelope.revision?.commit)}.`,
      next: verify,
    };
  if (!head || receipt.candidate?.commit !== head)
    return {
      verdict: "UNVERIFIED",
      summary: `Receipt ${receipt.id} proves ${short(receipt.candidate?.commit)}, but HEAD is ${short(head)}. Commits after the receipt aren't verified.`,
      next: verify,
    };
  return {
    verdict: "FIXED",
    summary: `HEAD ${short(head)} is proven: ${receipt.test.path} failed at ${short(receipt.baseline.commit)} and passes here, with no test files changed.`,
    next: "Safe to open or merge the pull request. Attach the receipt.",
  };
}
