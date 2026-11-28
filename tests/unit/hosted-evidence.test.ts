import { describe, expect, it } from "vitest";
import { agentResult } from "../../packages/core/src/agent-result.mjs";
import { evidenceEnvelopeSchema } from "../../shared/contracts/evidence";
import type { InvestigationReport } from "../../shared/contracts/investigation-execution";
import {
  HOSTED_NETWORK_LIMITATION,
  HOSTED_UNATTESTED_LIMITATION,
  verificationEnvelope,
  type VerificationFacts,
} from "../../worker/services/verification-evidence";

const A = "a".repeat(40);
const B = "b".repeat(40);
const report = (overrides: Partial<InvestigationReport> = {}): InvestigationReport => ({
  requestId: "req_" + "a".repeat(32),
  runId: "run-1",
  commit: A,
  status: "FAILED",
  command: { directory: ".", script: "test", testPath: "sum.test.ts" },
  counts: { passed: 0, failed: 1, skipped: 0 },
  failures: [{ file: "sum.test.ts", name: "adds", message: "Expected 3" }],
  message: "One failed",
  durationMs: 10,
  exitCode: 1,
  truncated: false,
  nodeVersion: "v22",
  ...overrides,
});
const passing = report({
  requestId: "req_" + "b".repeat(32),
  commit: B,
  status: "SUCCEEDED",
  counts: { passed: 1, failed: 0, skipped: 0 },
  failures: [],
  exitCode: 0,
});
const baselineRun = {
  commit: A,
  testPath: "sum.test.ts",
  status: "FAILED" as const,
  evidenceId: "evd_1",
  failure: { file: "sum.test.ts", name: "adds", message: "Expected 3" },
};
const candidateRun = { ...baselineRun, commit: B, status: "SUCCEEDED" as const, failure: null };
const attempt = (status: string) => ({
  status,
  created_at: "2026-11-25T08:00:00Z",
  updated_at: "2026-11-25T08:00:05Z",
});

const facts = (overrides: Partial<VerificationFacts> = {}): VerificationFacts => ({
  id: "ver_" + "c".repeat(32),
  repository: "fysaio/app",
  candidateCommit: B,
  createdAt: "2026-11-25T07:59:00Z",
  verdict: "PASSED",
  summary: "Confirmed.",
  baselineRun,
  candidateRun,
  baseline: report(),
  report: passing,
  candidateAttempt: attempt("SUCCEEDED"),
  changedFiles: ["sum.ts"],
  changedTests: [],
  comparisonIncomplete: false,
  limitations: ["Verification covers the recorded test file and execution conditions."],
  ...overrides,
});

describe("hosted verification evidence", () => {
  it("records a confirmed repair as a focused, unattested hosted pass", async () => {
    const envelope = await verificationEnvelope(facts());
    expect(evidenceEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({
      evidenceId: "ev_ver_" + "c".repeat(32),
      source: "HOSTED_UNATTESTED",
      scope: "FOCUSED",
      state: "COMPLETED",
      claim: "FOCUSED_PASS",
      repositoryId: "github:fysaio/app",
      revision: { commit: B, worktreeFingerprint: null },
      completedAt: "2026-11-25T08:00:05.000Z",
    });
    expect(envelope.limitations).toContain(HOSTED_UNATTESTED_LIMITATION);
    expect(envelope.limitations).toContain(HOSTED_NETWORK_LIMITATION);
    expect(envelope.limitations.join(" ")).toMatch(/safe to merge/);
    expect(envelope.revision.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each<[string, Partial<VerificationFacts>, string, string, string?]>([
    [
      "queued",
      { verdict: "PENDING", report: null, candidateRun: null, candidateAttempt: attempt("QUEUED") },
      "QUEUED",
      "NOT_RUN",
    ],
    [
      "running",
      {
        verdict: "PENDING",
        report: null,
        candidateRun: null,
        candidateAttempt: attempt("RUNNING"),
      },
      "RUNNING",
      "NOT_RUN",
    ],
    [
      "blocked",
      {
        verdict: "BLOCKED",
        report: null,
        candidateRun: null,
        candidateAttempt: attempt("BLOCKED"),
      },
      "BLOCKED",
      "INCONCLUSIVE",
    ],
    [
      "cancelled",
      {
        verdict: "BLOCKED",
        report: null,
        candidateRun: null,
        candidateAttempt: attempt("CANCELLED"),
      },
      "CANCELLED",
      "INCONCLUSIVE",
    ],
    [
      "still failing",
      {
        verdict: "FAILED",
        report: report({ commit: B }),
        candidateRun: { ...baselineRun, commit: B },
      },
      "FAILED",
      "FAILED",
      "passes-after:sum.test.ts",
    ],
    [
      "test changes",
      {
        verdict: "REVIEW_TEST_CHANGES",
        changedTests: ["sum.test.ts"],
        changedFiles: ["sum.test.ts"],
      },
      "COMPLETED",
      "INCONCLUSIVE",
      "test-inputs-unchanged",
    ],
    [
      "incomplete comparison",
      { verdict: "INCONCLUSIVE", comparisonIncomplete: true },
      "COMPLETED",
      "INCONCLUSIVE",
      "comparison-complete",
    ],
    [
      "no file changes",
      { verdict: "INCONCLUSIVE", changedFiles: [] },
      "COMPLETED",
      "INCONCLUSIVE",
      "files-changed",
    ],
    [
      "not reproduced",
      {
        verdict: "INCONCLUSIVE",
        baseline: report({
          status: "SUCCEEDED",
          counts: { passed: 1, failed: 0, skipped: 0 },
          failures: [],
          exitCode: 0,
        }),
        baselineRun: { ...baselineRun, status: "SUCCEEDED", failure: null },
      },
      "COMPLETED",
      "INCONCLUSIVE",
      "reproduces-before:sum.test.ts",
    ],
    [
      "new skips",
      {
        verdict: "INCONCLUSIVE",
        report: { ...passing, counts: { passed: 1, failed: 0, skipped: 2 } },
      },
      "COMPLETED",
      "INCONCLUSIVE",
      "no-new-skips",
    ],
    [
      "different test",
      { verdict: "INCONCLUSIVE", candidateRun: { ...candidateRun, testPath: "other.test.ts" } },
      "COMPLETED",
      "INCONCLUSIVE",
      "same-test-and-commit",
    ],
  ])("%s never claims a pass", async (_name, overrides, state, claim, failedCheck) => {
    const envelope = await verificationEnvelope(facts(overrides));
    expect(envelope).toMatchObject({ state, claim });
    if (failedCheck)
      expect(envelope.checks.find((check) => check.id === failedCheck)?.status).not.toBe("PASSED");
    if (claim === "INCONCLUSIVE" && state === "COMPLETED")
      expect(envelope.limitations.join(" ")).toMatch(/Not established/);
  });

  it("refuses a pass the verdict did not confirm, even if every check passed", async () => {
    const envelope = await verificationEnvelope(facts({ verdict: "INCONCLUSIVE" }));
    expect(envelope.claim).toBe("INCONCLUSIVE");
    expect(envelope.limitations.join(" ")).toMatch(/did not confirm a pass/);
  });

  it("keeps an unmanaged network boundary explicitly unattested", async () => {
    const envelope = await verificationEnvelope(facts());
    expect(envelope.source).toBe("HOSTED_UNATTESTED");
    expect(envelope.claim).toBe("FOCUSED_PASS");
    expect(envelope.limitations).toContain(HOSTED_NETWORK_LIMITATION);
    expect(envelope.limitations.join(" ")).toMatch(/unrestricted outbound network access/);
  });

  it("keeps the claim when the hosted MCP response is compacted", async () => {
    const evidence = await verificationEnvelope(facts());
    const { structuredContent } = agentResult(
      {
        status: "PASSED",
        summary: "x".repeat(4000),
        verification: {
          id: "ver_1",
          baselineId: "inv_1",
          candidateId: "inv_2",
          verdict: "PASSED",
          label: "Confirmed",
          baselineRun,
          candidateRun,
          changedTests: [],
          metrics: {},
          evidence,
        },
      },
      1000,
    );
    expect((structuredContent.verification as { claim: unknown }).claim).toMatchObject({
      state: "COMPLETED",
      claim: "FOCUSED_PASS",
      scope: "FOCUSED",
      source: "HOSTED_UNATTESTED",
      commit: B,
    });
  });
});
