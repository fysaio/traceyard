import { z } from "zod";
export const verificationRequestSchema = z
  .object({
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    requestKey: z
      .string()
      .regex(/^[A-Za-z0-9._-]{8,128}$/)
      .optional(),
  })
  .strict();
export interface Verification {
  id: string;
  baselineId: string;
  candidateId: string;
  candidateCommit: string;
  verdict: "PENDING" | "PASSED" | "FAILED" | "BLOCKED" | "REVIEW_TEST_CHANGES" | "INCONCLUSIVE";
  changedTests: string[];
  limitations: string[];
  summary: string;
  metrics: {
    baselineDurationMs: number | null;
    candidateDurationMs: number | null;
    evidenceChars: number;
    providerCalls: null;
    agentTokens: null;
  };
}
