import { z } from "zod";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceId = z.string().regex(/^ev_[a-z0-9][a-z0-9_-]{2,127}$/);

export const evidenceScopeSchema = z.enum(["FOCUSED", "AFFECTED", "REQUIRED", "FULL"]);
export type EvidenceScope = z.infer<typeof evidenceScopeSchema>;

export const evidenceSourceSchema = z.enum(["LOCAL_PROVISIONAL", "HOSTED_ATTESTED"]);
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

/** Execution lifecycle is deliberately separate from the claim made about the result. */
export const evidenceStateSchema = z.enum([
  "PLANNED",
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
  "STALE",
  "REJECTED",
]);
export type EvidenceState = z.infer<typeof evidenceStateSchema>;

/** A focused pass is not a required-check pass and neither implies merge safety. */
export const evidenceClaimSchema = z.enum([
  "NOT_RUN",
  "FOCUSED_PASS",
  "REQUIRED_PASS",
  "FAILED",
  "INCONCLUSIVE",
]);
export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;

export const evidenceCheckSchema = z
  .object({
    id: z.string().min(1).max(240),
    status: z.enum(["PASSED", "FAILED", "BLOCKED", "CANCELLED", "SKIPPED", "NOT_RUN"]),
    required: z.boolean(),
  })
  .strict();

export const evidenceEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceId,
    runId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
    repositoryId: z.string().min(1).max(256),
    source: evidenceSourceSchema,
    scope: evidenceScopeSchema,
    state: evidenceStateSchema,
    claim: evidenceClaimSchema,
    revision: z
      .object({
        commit: z
          .string()
          .regex(/^[a-f0-9]{40}$/)
          .nullable(),
        worktreeFingerprint: fingerprint.nullable(),
        inputFingerprint: fingerprint,
        policyFingerprint: fingerprint,
        environmentFingerprint: fingerprint,
      })
      .strict(),
    checks: z.array(evidenceCheckSchema).max(1000),
    limitations: z.array(z.string().min(1).max(500)).max(100),
    /** The next step for a person or agent. Optional so older envelopes still parse. */
    next: z.string().min(1).max(500).optional(),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((evidence, context) => {
    const add = (message: string, path: (string | number)[] = ["claim"]) =>
      context.addIssue({ code: "custom", message, path });

    if (["COMPLETED", "FAILED"].includes(evidence.state) && !evidence.completedAt)
      add("A terminal evidence state needs completedAt.", ["completedAt"]);
    if (!["COMPLETED", "FAILED"].includes(evidence.state) && evidence.completedAt)
      add("Only a completed or failed run may have completedAt.", ["completedAt"]);

    if (evidence.claim === "FOCUSED_PASS") {
      if (evidence.state !== "COMPLETED") add("A focused pass requires completed evidence.");
      if (evidence.scope !== "FOCUSED") add("A focused pass must have FOCUSED scope.");
      if (evidence.checks.some((check) => check.status !== "PASSED"))
        add("A focused pass requires every selected check to pass.");
    }
    if (evidence.claim === "REQUIRED_PASS") {
      if (evidence.state !== "COMPLETED") add("A required pass requires completed evidence.");
      if (evidence.scope !== "REQUIRED" && evidence.scope !== "FULL")
        add("A required pass needs REQUIRED or FULL scope.");
      if (evidence.checks.some((check) => check.required && check.status !== "PASSED"))
        add("A required pass cannot omit or fail a required check.");
    }
    if (evidence.claim === "FAILED" && evidence.state !== "FAILED")
      add("A failed claim requires FAILED state.");
    if (
      evidence.claim === "INCONCLUSIVE" &&
      !["COMPLETED", "BLOCKED", "CANCELLED", "STALE", "REJECTED"].includes(evidence.state)
    )
      add(
        "An inconclusive claim requires incomplete, blocked, cancelled, stale, or rejected evidence.",
      );
    if (
      evidence.claim === "INCONCLUSIVE" &&
      evidence.state === "COMPLETED" &&
      evidence.checks.every((check) => check.status === "PASSED") &&
      evidence.limitations.length === 0
    )
      add("A completed inconclusive run must identify incomplete checks or a limitation.");
    if (evidence.claim === "NOT_RUN" && !["PLANNED", "QUEUED", "RUNNING"].includes(evidence.state))
      add("A not-run claim requires planned, queued, or running evidence.");
    if (!evidence.revision.commit && !evidence.revision.worktreeFingerprint)
      add("Evidence must identify an exact commit or a working-tree fingerprint.", [
        "revision",
        "commit",
      ]);
    if (evidence.source === "HOSTED_ATTESTED" && !evidence.revision.commit)
      add("Hosted attested evidence must identify an exact commit.", ["revision", "commit"]);
    if (
      evidence.state === "STALE" &&
      !evidence.limitations.some((item) => /stale|changed|superseded/i.test(item))
    )
      add("Stale evidence must explain which input changed.", ["limitations"]);
  });

export type EvidenceEnvelope = z.infer<typeof evidenceEnvelopeSchema>;

export type EvidenceOutcome = Pick<EvidenceEnvelope, "state" | "claim">;

/** Derive only claims that are safe for the supplied execution state and check set. */
export function deriveEvidenceOutcome(input: {
  state: EvidenceState;
  scope: EvidenceScope;
  checks: Array<z.infer<typeof evidenceCheckSchema>>;
}): EvidenceOutcome {
  if (["PLANNED", "QUEUED", "RUNNING"].includes(input.state))
    return { state: input.state, claim: "NOT_RUN" };
  if (["BLOCKED", "CANCELLED", "STALE", "REJECTED"].includes(input.state))
    return { state: input.state, claim: "INCONCLUSIVE" };
  if (input.state === "FAILED") return { state: "FAILED", claim: "FAILED" };
  if (input.checks.some((check) => check.status !== "PASSED"))
    return { state: "COMPLETED", claim: "INCONCLUSIVE" };
  return {
    state: "COMPLETED",
    claim: input.scope === "FOCUSED" ? "FOCUSED_PASS" : "REQUIRED_PASS",
  };
}
