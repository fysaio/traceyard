import { z } from "zod";
import type { EvidenceEnvelope } from "./evidence";
import type { InvestigationReport } from "./investigation-execution";
export const verificationRequestSchema = z
  .object({
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    requestKey: z
      .string()
      .regex(/^[A-Za-z0-9._-]{8,128}$/)
      .optional(),
  })
  .strict();
export interface VerificationRun {
  commit: string;
  testPath: string;
  testCase?: string;
  status: InvestigationReport["status"];
  evidenceId: string | null;
  failure: InvestigationReport["failures"][number] | null;
}

export interface Verification {
  id: string;
  baselineId: string;
  candidateId: string;
  candidateCommit: string;
  verdict: "PENDING" | "PASSED" | "FAILED" | "BLOCKED" | "REVIEW_TEST_CHANGES" | "INCONCLUSIVE";
  label: "Running" | "Confirmed" | "Passed with test changes" | "Still failing" | "Inconclusive";
  baselineRun: VerificationRun | null;
  candidateRun: VerificationRun | null;
  changedTests: string[];
  limitations: string[];
  summary: string;
  /** Versioned evidence envelope for this verification. Always HOSTED_UNATTESTED for now. */
  evidence: EvidenceEnvelope;
  metrics: {
    baselineDurationMs: number | null;
    candidateDurationMs: number | null;
    evidenceChars: number;
    providerCalls: null;
    agentTokens: null;
  };
}
