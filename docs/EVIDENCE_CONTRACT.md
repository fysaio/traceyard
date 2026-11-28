# Evidence contract

TraceYard uses the versioned envelope in [`shared/contracts/evidence.ts`](../shared/contracts/evidence.ts) for local CLI/MCP results and hosted verification results. The TypeScript schema is authoritative; `packages/core/src/evidence.mjs` is the JavaScript mirror used by the CLI.

## Scope semantics

- `FOCUSED` covers selected checks, such as one recorded test. A passing result may claim `FOCUSED_PASS`, but it is not a full-suite or merge-safety claim.
- `AFFECTED` describes checks selected from changed or affected files. It does not by itself establish a required-check pass; a completed affected-only run remains `INCONCLUSIVE` until a stronger required-check scope is established.
- `REQUIRED` covers the repository’s required checks.
- `FULL` covers the declared full suite.

A completed run with no checks is always `INCONCLUSIVE`. An empty check list cannot establish either pass claim. A non-empty set of all-passing checks can produce `FOCUSED_PASS` only for `FOCUSED` scope, or `REQUIRED_PASS` only for `REQUIRED` or `FULL` scope. Any failed, skipped, blocked, cancelled, or not-run check prevents a pass claim.

## State and claim matrix

The lifecycle `state` describes what happened. The `claim` describes what the evidence safely establishes.

| State                                       | Derived claim   | Meaning                                                                                                          |
| ------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PLANNED`, `QUEUED`, `RUNNING`              | `NOT_RUN`       | Execution has not produced completed evidence.                                                                   |
| `COMPLETED`                                 | `FOCUSED_PASS`  | Every selected check passed under `FOCUSED` scope, with at least one check.                                      |
| `COMPLETED`                                 | `REQUIRED_PASS` | Every executed check passed under `REQUIRED` or `FULL` scope, with at least one check.                           |
| `COMPLETED`                                 | `INCONCLUSIVE`  | Checks are empty, incomplete, or scoped only to `AFFECTED`; limitations explain what remains unknown.            |
| `FAILED`                                    | `FAILED`        | Execution completed with a failure result.                                                                       |
| `BLOCKED`, `CANCELLED`, `STALE`, `REJECTED` | `INCONCLUSIVE`  | The run cannot establish a pass; the limitation identifies the block, cancellation, changed input, or rejection. |

Claims are derived from state, scope, and check statuses. Callers cannot supply a stronger claim directly, and the schema rejects contradictory state/claim pairs.

## Compatibility boundaries

Schema version `1` is additive: older version-1 envelopes that omit optional fields such as `next` remain valid. Older CLI results and receipts that predate the envelope remain supported at their existing boundaries: `evidenceEnvelope` is optional in the CLI result contract, and `guard` accepts older receipts without an envelope. Compatibility does not synthesize a pass claim for an old payload.

The GitHub Action evidence artifact under `runner/test-evidence/` remains a separate report-history format. It validates test observations and GitHub history matching; it is not silently treated as a versioned `EvidenceEnvelope`. The worker and CLI paths use the shared envelope explicitly.
