import { z } from "zod";
import { repositoryPathSchema } from "./repository-index";

const reference = z.string().trim().min(1).max(200);
export const investigationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), operationKey: reference.optional() }).strict(),
  z.object({ kind: z.literal("check"), ref: reference }).strict(),
  z.object({ kind: z.literal("trace"), ref: reference }).strict(),
  z.object({ kind: z.literal("execution"), ref: reference }).strict(),
]);
export const investigationRequestSchema = z
  .object({
    mode: z.enum(["analyze", "execute"]).default("analyze"),
    testPath: repositoryPathSchema.optional(),
    question: z.string().trim().min(3).max(1000),
    target: investigationTargetSchema.default({ kind: "source" }),
    requestKey: z
      .string()
      .regex(/^[A-Za-z0-9._-]{8,128}$/)
      .optional(),
    outputChars: z.number().int().min(500).max(12000).default(3000),
  })
  .strict();
export type InvestigationRequest = z.infer<typeof investigationRequestSchema>;
export type InvestigationTarget = z.infer<typeof investigationTargetSchema>;
export type InvestigationStatus =
  "ANALYZING" | "EXECUTING" | "EVIDENCE_READY" | "BLOCKED" | "CANCELLED" | "FAILED";
export interface SourceSnapshot {
  repository: string | null;
  commit: string | null;
  filesScanned: number;
  warnings: string[];
}
export interface InvestigationEvidence {
  id: string;
  kind: "source" | "check" | "trace" | "execution" | "diagnostic";
  basis: "observed" | "source";
  title: string;
  content: unknown;
  truncated: boolean;
}
export interface Investigation {
  schemaVersion: 1;
  id: string;
  projectId: string;
  question: string;
  target: InvestigationTarget;
  status: InvestigationStatus;
  snapshot: SourceSnapshot;
  finding: {
    summary: string;
    basis: "observed" | "source";
    limitations: string[];
    nextAction: string | null;
  };
  evidence: Omit<InvestigationEvidence, "content">[];
  attempts?: {
    id: string;
    requestId: string;
    status: string;
    checkId: string | null;
    createdAt: string;
  }[];
  createdAt: string;
  updatedAt: string;
  browserPath: string;
  budget: { outputChars: number; returnedChars: number; truncated: boolean };
}
