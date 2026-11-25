import { describe, expect, it } from "vitest";
import { deriveEvidenceOutcome, evidenceEnvelopeSchema } from "../../shared/contracts/evidence";

const fingerprint = "a".repeat(64);
const base = {
  schemaVersion: 1 as const,
  evidenceId: "ev_fixture_run",
  runId: "run_fixture",
  requestId: "req_fixture",
  repositoryId: "github:fysaio/traceyard",
  source: "LOCAL_PROVISIONAL" as const,
  scope: "FOCUSED" as const,
  state: "COMPLETED" as const,
  claim: "FOCUSED_PASS" as const,
  revision: {
    commit: "a".repeat(40),
    worktreeFingerprint: fingerprint,
    inputFingerprint: fingerprint,
    policyFingerprint: fingerprint,
    environmentFingerprint: fingerprint,
  },
  checks: [{ id: "vitest:sum.test.ts", status: "PASSED" as const, required: false }],
  limitations: ["Only the selected test file was executed."],
  startedAt: "2026-11-23T17:00:00+00:00",
  completedAt: "2026-11-23T17:00:01+00:00",
};

describe("versioned evidence contract", () => {
  it("accepts a focused pass without presenting it as a required pass", () => {
    const result = evidenceEnvelopeSchema.safeParse(base);
    expect(result.success).toBe(true);
    expect(result.success && result.data.claim).toBe("FOCUSED_PASS");
  });

  it("derives inconclusive rather than pass for incomplete checks", () => {
    expect(
      deriveEvidenceOutcome({
        state: "COMPLETED",
        scope: "REQUIRED",
        checks: [{ id: "unit", status: "SKIPPED", required: true }],
      }),
    ).toEqual({ state: "COMPLETED", claim: "INCONCLUSIVE" });
  });

  it("accepts a completed inconclusive run when a required check was not run", () => {
    const result = evidenceEnvelopeSchema.safeParse({
      ...base,
      scope: "REQUIRED",
      claim: "INCONCLUSIVE",
      checks: [{ id: "integration", status: "NOT_RUN", required: true }],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["BLOCKED", "INCONCLUSIVE"],
    ["CANCELLED", "INCONCLUSIVE"],
    ["STALE", "INCONCLUSIVE"],
    ["REJECTED", "INCONCLUSIVE"],
  ] as const)("never turns %s execution into a pass", (state, claim) => {
    expect(deriveEvidenceOutcome({ state, scope: "FULL", checks: [] })).toEqual({ state, claim });
  });

  it("requires a changed-input explanation for stale evidence", () => {
    const result = evidenceEnvelopeSchema.safeParse({
      ...base,
      state: "STALE",
      claim: "INCONCLUSIVE",
      completedAt: null,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected stale evidence to be rejected");
    expect(result.error.issues.some((issue) => issue.path.join(".") === "limitations")).toBe(true);
  });

  it.each(["HOSTED_UNATTESTED", "HOSTED_ATTESTED"] as const)(
    "requires an exact commit for %s evidence",
    (source) => {
      const result = evidenceEnvelopeSchema.safeParse({
        ...base,
        source,
        revision: { ...base.revision, commit: null },
      });
      expect(result.success).toBe(false);
      if (result.success)
        throw new Error("Expected hosted evidence without a commit to be rejected");
      expect(result.error.issues.some((issue) => issue.path.join(".") === "revision.commit")).toBe(
        true,
      );
    },
  );

  it("rejects a required pass with a missing required check", () => {
    const result = evidenceEnvelopeSchema.safeParse({
      ...base,
      scope: "REQUIRED",
      claim: "REQUIRED_PASS",
      checks: [
        { id: "unit", status: "PASSED", required: true },
        { id: "integration", status: "NOT_RUN", required: true },
      ],
    });
    expect(result.success).toBe(false);
  });
});
