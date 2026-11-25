export type EvidenceScope = "FOCUSED" | "AFFECTED" | "REQUIRED" | "FULL";
export type EvidenceSource = "LOCAL_PROVISIONAL" | "HOSTED_UNATTESTED" | "HOSTED_ATTESTED";
export type EvidenceState =
  | "PLANNED"
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED"
  | "STALE"
  | "REJECTED";
export type EvidenceClaim =
  "NOT_RUN" | "FOCUSED_PASS" | "REQUIRED_PASS" | "FAILED" | "INCONCLUSIVE";
export interface EvidenceCheck {
  id: string;
  status: "PASSED" | "FAILED" | "BLOCKED" | "CANCELLED" | "SKIPPED" | "NOT_RUN";
  required: boolean;
}
export interface EvidenceRevision {
  commit: string | null;
  worktreeFingerprint: string | null;
  inputFingerprint: string;
  policyFingerprint: string;
  environmentFingerprint: string;
}
export interface EvidenceEnvelope {
  schemaVersion: 1;
  evidenceId: string;
  runId: string;
  requestId: string;
  repositoryId: string;
  source: EvidenceSource;
  scope: EvidenceScope;
  state: EvidenceState;
  claim: EvidenceClaim;
  revision: EvidenceRevision;
  checks: EvidenceCheck[];
  limitations: string[];
  next?: string;
  startedAt: string;
  completedAt: string | null;
}
export interface EvidenceClaimSummary {
  evidenceId: string;
  state: EvidenceState;
  claim: EvidenceClaim;
  scope: EvidenceScope;
  source: EvidenceSource;
  commit: string | null;
  worktree: string | null;
  limitations: string[];
}

export const EVIDENCE_SCHEMA_VERSION: 1;
export function canonicalJson(value: unknown): string;
export function fingerprint(value: unknown): string;
export function deriveEvidenceOutcome(input: {
  state: EvidenceState;
  scope: EvidenceScope;
  checks: EvidenceCheck[];
}): { state: EvidenceState; claim: EvidenceClaim };
export function buildEvidenceEnvelope(input: {
  evidenceId: string;
  runId: string;
  requestId: string;
  repositoryId: string;
  source: EvidenceSource;
  scope: EvidenceScope;
  state: EvidenceState;
  revision: Partial<Pick<EvidenceRevision, "commit" | "worktreeFingerprint">> &
    Pick<EvidenceRevision, "inputFingerprint" | "policyFingerprint" | "environmentFingerprint">;
  checks: EvidenceCheck[];
  limitations?: string[];
  next?: string;
  startedAt: string;
  completedAt: string | null;
}): EvidenceEnvelope;
export function evidenceClaimSummary(envelope: EvidenceEnvelope): EvidenceClaimSummary;
