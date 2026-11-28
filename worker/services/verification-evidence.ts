// The versioned evidence envelope for a hosted verification
// (shared/contracts/evidence.ts). Built on every read from the same stored
// attempts as the verdict, so the two can't drift apart.
//
// Hosted evidence is HOSTED_UNATTESTED: the runner that executes repository
// code also writes the report, so the report could be forged by that code.
// It only becomes HOSTED_ATTESTED once a trusted supervisor reports instead.

import {
  canonicalJson,
  deriveEvidenceOutcome,
  evidenceEnvelopeSchema,
  type EvidenceEnvelope,
  type EvidenceState,
} from "../../shared/contracts/evidence";
import type { InvestigationReport } from "../../shared/contracts/investigation-execution";
import type { Verification, VerificationRun } from "../../shared/contracts/verification";
import { sha256Hex } from "../lib/crypto";

type Check = EvidenceEnvelope["checks"][number];
type Status = Check["status"];

export const HOSTED_UNATTESTED_LIMITATION =
  "Hosted result, not attested: the runner that executed the repository's code also reported the result.";
export const HOSTED_NETWORK_LIMITATION =
  "Hosted network boundary not attested: repository processes run with unrestricted outbound network access; Traceyard does not enforce a deny or allowlist policy.";

const fingerprint = (value: unknown) => sha256Hex(canonicalJson(value));
const pass = (ok: boolean): Status => (ok ? "PASSED" : "FAILED");

export interface VerificationFacts {
  id: string;
  repository: string | null;
  candidateCommit: string;
  createdAt: string;
  verdict: Verification["verdict"];
  summary: string;
  baselineRun: VerificationRun | null;
  candidateRun: VerificationRun | null;
  baseline: InvestigationReport | null;
  report: InvestigationReport | null;
  candidateAttempt: { status: string; created_at: string; updated_at: string } | null;
  changedFiles: string[];
  changedTests: string[];
  comparisonIncomplete: boolean;
  limitations: string[];
}

const NEXT: Record<Verification["verdict"], string> = {
  PENDING: "Wait for the candidate run, then read the verification again.",
  PASSED:
    "Attach this verification to the pull request. It covers the recorded test only, not the whole suite.",
  FAILED: "Change the code and verify a new candidate commit.",
  BLOCKED: "Fix what blocked the candidate run, then verify again.",
  REVIEW_TEST_CHANGES: "Review the changed test and fixture files before relying on the result.",
  INCONCLUSIVE: "Read the failed check and its limitation, then verify again.",
};

/** One check per rule the verdict depends on, from the same facts. */
export function verificationChecks(facts: VerificationFacts): Check[] {
  const { baselineRun, candidateRun, baseline, report } = facts;
  const label = baselineRun
    ? baselineRun.testCase
      ? `${baselineRun.testPath}::${baselineRun.testCase}`
      : baselineRun.testPath
    : "recorded-test";
  const reproduced =
    !!baselineRun?.failure && !!baseline?.counts.failed && baselineRun.status === "FAILED";
  const blocked =
    facts.candidateAttempt?.status === "BLOCKED" || facts.candidateAttempt?.status === "CANCELLED";
  const ran = !!report && !blocked;
  const sameTest =
    !!candidateRun &&
    !!baselineRun &&
    candidateRun.testPath === baselineRun.testPath &&
    candidateRun.testCase === baselineRun.testCase &&
    candidateRun.commit === facts.candidateCommit;
  const reportMatchesCandidate = !!report && report.commit === facts.candidateCommit;
  let passesAfter: Status = "NOT_RUN";
  if (blocked) passesAfter = "BLOCKED";
  else if (ran)
    passesAfter =
      candidateRun?.status === "FAILED" || (report?.counts.failed ?? 0) > 0
        ? "FAILED"
        : candidateRun?.status === "SUCCEEDED" && report!.counts.passed > 0
          ? "PASSED"
          : "SKIPPED";
  const after = (ok: boolean): Status => (ran ? pass(ok) : "NOT_RUN");
  return [
    { id: `reproduces-before:${label}`, status: pass(reproduced), required: false },
    { id: "same-test-and-commit", status: after(sameTest), required: false },
    { id: "report-commit", status: after(reportMatchesCandidate), required: false },
    { id: `passes-after:${label}`, status: passesAfter, required: false },
    {
      id: "no-new-skips",
      status: after((report?.counts.skipped ?? 0) <= (baseline?.counts.skipped ?? 0)),
      required: false,
    },
    { id: "comparison-complete", status: pass(!facts.comparisonIncomplete), required: false },
    {
      id: "files-changed",
      status: pass(facts.changedFiles.length > 0 && facts.candidateCommit !== baselineRun?.commit),
      required: false,
    },
    { id: "test-inputs-unchanged", status: pass(!facts.changedTests.length), required: false },
  ];
}

function stateFor(facts: VerificationFacts): EvidenceState {
  switch (facts.verdict) {
    case "PENDING":
      return facts.candidateAttempt?.status === "RUNNING" ? "RUNNING" : "QUEUED";
    case "BLOCKED":
      return facts.candidateAttempt?.status === "CANCELLED" ? "CANCELLED" : "BLOCKED";
    case "FAILED":
      return "FAILED";
    default:
      return "COMPLETED";
  }
}

export async function verificationEnvelope(facts: VerificationFacts): Promise<EvidenceEnvelope> {
  const checks = verificationChecks(facts);
  const outcome = deriveEvidenceOutcome({ state: stateFor(facts), scope: "FOCUSED", checks });
  // The verdict is the authority for a pass: the checks may only narrow it.
  const disagrees = outcome.claim === "FOCUSED_PASS" && facts.verdict !== "PASSED";
  if (disagrees) outcome.claim = "INCONCLUSIVE";
  const test = facts.baselineRun
    ? { path: facts.baselineRun.testPath, case: facts.baselineRun.testCase ?? null }
    : null;
  const limitations = [
    HOSTED_UNATTESTED_LIMITATION,
    HOSTED_NETWORK_LIMITATION,
    `Covers only ${test ? test.path + (test.case ? "::" + test.case : "") : "the recorded test"}; it says nothing about other tests or whether the change is safe to merge.`,
    ...facts.limitations,
  ];
  const failed = checks.filter((check) => check.status !== "PASSED" && check.status !== "NOT_RUN");
  if (outcome.state === "COMPLETED" && outcome.claim === "INCONCLUSIVE" && failed.length)
    limitations.push(`Not established: ${failed.map((check) => check.id).join(", ")}.`);
  if (disagrees)
    limitations.push("The checks passed, but the verification verdict did not confirm a pass.");
  if (outcome.state === "BLOCKED" || outcome.state === "CANCELLED")
    limitations.push(facts.summary.slice(0, 400) || "The candidate run did not complete.");
  const terminal = outcome.state === "COMPLETED" || outcome.state === "FAILED";
  const envelope = {
    schemaVersion: 1 as const,
    evidenceId: "ev_" + facts.id.toLowerCase(),
    runId: facts.report?.runId ?? facts.id,
    requestId: facts.report?.requestId ?? facts.id,
    repositoryId: facts.repository ? "github:" + facts.repository : "verification:" + facts.id,
    source: "HOSTED_UNATTESTED" as const,
    scope: "FOCUSED" as const,
    state: outcome.state,
    claim: outcome.claim,
    revision: {
      commit: facts.candidateCommit,
      worktreeFingerprint: null,
      inputFingerprint: await fingerprint({
        verification: facts.id,
        test,
        baseline: facts.baselineRun?.commit ?? null,
        candidate: facts.candidateCommit,
        changedFiles: [...facts.changedFiles].sort(),
      }),
      policyFingerprint: await fingerprint({ policy: "traceyard-hosted-verification", version: 1 }),
      environmentFingerprint: await fingerprint({
        baseline: facts.baseline
          ? { node: facts.baseline.nodeVersion, script: facts.baseline.command.script }
          : null,
        candidate: facts.report
          ? {
              node: facts.report.nodeVersion,
              script: facts.report.command.script,
              replay: facts.report.replay?.isolation ?? null,
            }
          : null,
      }),
    },
    checks,
    limitations: [...new Set(limitations)].slice(0, 100).map((item) => item.slice(0, 500)),
    next: NEXT[facts.verdict],
    startedAt: toIso(facts.candidateAttempt?.created_at ?? facts.createdAt),
    completedAt: terminal ? toIso(facts.candidateAttempt?.updated_at ?? facts.createdAt) : null,
  };
  // Never return an envelope the contract would reject.
  return evidenceEnvelopeSchema.parse(envelope);
}

const toIso = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
};
