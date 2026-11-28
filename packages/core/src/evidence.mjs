// Versioned evidence envelope (schema version 1), the JavaScript side of
// shared/contracts/evidence.ts. Pure functions only: no I/O, no clock.
//
// The TypeScript schema is the authority. Tests check that every envelope
// built here parses against it and that `deriveEvidenceOutcome` here returns
// the same outcome as the TypeScript version for every state and scope.

import { createHash } from "node:crypto";

export const EVIDENCE_SCHEMA_VERSION = 1;

const PENDING = ["PLANNED", "QUEUED", "RUNNING"];
const INTERRUPTED = ["BLOCKED", "CANCELLED", "STALE", "REJECTED"];
const TERMINAL = ["COMPLETED", "FAILED"];

const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : value;

/** Stable JSON with sorted keys at every level. */
export const canonicalJson = (value) => JSON.stringify(sorted(value));

/** 64-character lowercase SHA-256 of a value's canonical JSON. */
export const fingerprint = (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Derive only claims that are safe for the supplied execution state and check set. */
export function deriveEvidenceOutcome({ state, scope, checks }) {
  if (PENDING.includes(state)) return { state, claim: "NOT_RUN" };
  if (INTERRUPTED.includes(state)) return { state, claim: "INCONCLUSIVE" };
  if (state === "FAILED") return { state: "FAILED", claim: "FAILED" };
  if (checks.length === 0 || checks.some((check) => check.status !== "PASSED"))
    return { state: "COMPLETED", claim: "INCONCLUSIVE" };
  if (scope === "AFFECTED") return { state: "COMPLETED", claim: "INCONCLUSIVE" };
  return { state: "COMPLETED", claim: scope === "FOCUSED" ? "FOCUSED_PASS" : "REQUIRED_PASS" };
}

/**
 * Assemble an envelope. The claim is always derived, never supplied, so a
 * caller cannot turn blocked, stale or incomplete evidence into a pass.
 * A completed run that is inconclusive must say why, so a generic limitation
 * is added when the caller gave none.
 */
export function buildEvidenceEnvelope({
  evidenceId,
  runId,
  requestId,
  repositoryId,
  source,
  scope,
  state,
  revision,
  checks,
  limitations = [],
  next,
  startedAt,
  completedAt,
}) {
  const outcome = deriveEvidenceOutcome({ state, scope, checks });
  const notes = [...new Set(limitations.filter(Boolean).map((item) => item.slice(0, 500)))];
  if (
    outcome.state === "COMPLETED" &&
    outcome.claim === "INCONCLUSIVE" &&
    checks.every((check) => check.status === "PASSED") &&
    notes.length === 0
  )
    notes.push("The run completed without enough evidence for a pass.");
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceId,
    runId,
    requestId,
    repositoryId,
    source,
    scope,
    state: outcome.state,
    claim: outcome.claim,
    revision: {
      commit: revision.commit ?? null,
      worktreeFingerprint: revision.worktreeFingerprint ?? null,
      inputFingerprint: revision.inputFingerprint,
      policyFingerprint: revision.policyFingerprint,
      environmentFingerprint: revision.environmentFingerprint,
    },
    checks: checks.slice(0, 1000),
    limitations: notes.slice(0, 100),
    ...(next ? { next: next.slice(0, 500) } : {}),
    startedAt,
    completedAt: TERMINAL.includes(outcome.state) ? completedAt : null,
  };
}

/**
 * The part of an envelope an agent must never lose: what state the run is in,
 * what it claims, how wide the claim is, where it came from and which revision
 * it is about. Compact responses keep this and may shorten only limitations.
 */
export function evidenceClaimSummary(envelope) {
  return {
    evidenceId: envelope.evidenceId,
    state: envelope.state,
    claim: envelope.claim,
    scope: envelope.scope,
    source: envelope.source,
    commit: envelope.revision.commit,
    worktree: envelope.revision.worktreeFingerprint
      ? envelope.revision.worktreeFingerprint.slice(0, 12)
      : null,
    limitations: envelope.limitations,
  };
}
