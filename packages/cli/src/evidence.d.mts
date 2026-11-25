import type { EvidenceEnvelope } from "../../core/src/evidence.mjs";

interface Run {
  commit: string | null;
  status: "SUCCEEDED" | "FAILED" | "BLOCKED";
  counts: { passed: number; failed: number; skipped: number };
  message: string;
  truncated?: boolean;
  cached?: boolean;
  recordedAt?: string;
  evidenceId?: string | null;
  dependencies?: string;
  runner?: { script: string; directory: string } | null;
}
interface SelectedTest {
  path: string;
  case: string | null;
}
interface Common {
  test: SelectedTest;
  repository: string;
  requestId: string;
  next?: string;
  startedAt: string;
  completedAt: string;
}

export const LOCAL_LIMITATION: string;
export function isStandardLimitation(text: string): boolean;
export function policyFingerprint(): string;
export function newRequestId(): string;
export function repositoryId(github: string | null, root: string): string;
export function singleRunEnvelope(
  input: Common & {
    command: "repro" | "check";
    run: Run;
    worktree?: { fingerprint: string; stale: boolean; complete: boolean } | null;
  },
): EvidenceEnvelope;
export function verifyEnvelope(
  input: Common & { baseline: Run; candidate: Run | null; changedTests: string[] },
): EvidenceEnvelope;
