import { z } from "zod";
import { evidenceEnvelopeSchema } from "./evidence";

// The `traceyard --json` output contract. Documented in docs/CLI.md. The local
// MCP server (#48) returns the same shapes. Additive changes keep
// schemaVersion 1; removing or renaming a field bumps it.

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const evidenceId = z.string().regex(/^ev_[a-z0-9]+_[a-z0-9_]+$/);
const counts = z
  .object({
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
  })
  .strict();

export const cliVerdicts = [
  "REPRODUCED",
  "NOT_REPRODUCED",
  "PASSED",
  "FAILING",
  "FIXED",
  "AVAILABLE",
  "STILL_FAILING",
  "UNVERIFIED",
  "NEEDS_REVIEW",
  "INCONCLUSIVE",
  "BLOCKED",
  "ERROR",
] as const;

export const cliExitCodes = {
  REPRODUCED: 0,
  PASSED: 0,
  FIXED: 0,
  AVAILABLE: 0,
  FAILING: 1,
  STILL_FAILING: 1,
  UNVERIFIED: 1,
  NOT_REPRODUCED: 2,
  NEEDS_REVIEW: 2,
  INCONCLUSIVE: 2,
  BLOCKED: 3,
  ERROR: 64,
} as const satisfies Record<(typeof cliVerdicts)[number], number>;

export const cliRunSchema = z
  .object({
    role: z.enum(["repro", "check", "baseline", "candidate"]),
    commit: sha.nullable(),
    workingTree: z.boolean(),
    status: z.enum(["SUCCEEDED", "FAILED", "BLOCKED"]),
    counts,
    failures: z
      .array(
        z.object({ file: z.string(), name: z.string(), message: z.string().max(600) }).strict(),
      )
      .max(5),
    truncated: z.boolean(),
    durationMs: z.number().int().min(0),
    cached: z.boolean(),
    dependencies: z.enum(["none", "existing", "linked", "cached", "installed"]),
    evidenceId: evidenceId.nullable(),
    message: z.string().max(600),
    output: z.string().max(4000).optional(),
  })
  .strict();

export const cliResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    command: z
      .enum(["repro", "check", "verify", "guard", "explain", "inspect", "receipt"])
      .nullable(),
    verdict: z.enum(cliVerdicts),
    exitCode: z.number().int(),
    summary: z.string(),
    next: z.string(),
    test: z.object({ path: z.string(), case: z.string().nullable() }).strict().nullable(),
    runs: z.array(cliRunSchema).max(2),
    changedTests: z.array(z.string()).optional(),
    source: z
      .object({ jobUrl: z.string().url(), commit: sha, mergeCommit: z.boolean() })
      .strict()
      .optional(),
    receipt: z
      .object({
        id: z.string().regex(/^rcpt_\d{17}_[a-f0-9]{6}$/),
        path: z.string(),
        markdownPath: z.string(),
        intact: z.boolean().optional(),
        body: z.record(z.string(), z.unknown()).optional(),
        markdown: z.string().optional(),
      })
      .strict()
      .optional(),
    // inspect without an ID: recent runs and receipts.
    items: z
      .array(
        z
          .object({
            kind: z.enum(["run", "receipt"]),
            id: z.string(),
            test: z.string().nullable(),
            commit: sha.nullable(),
            status: z.string(),
            recordedAt: z.string().nullable(),
          })
          .strict(),
      )
      .max(13)
      .optional(),
    // inspect <evidence>: one bounded slice of a run's full log.
    evidence: z
      .object({
        id: evidenceId,
        offset: z.number().int().min(0),
        nextOffset: z.number().int().min(0).nullable(),
        total: z.number().int().min(0),
        text: z.string().max(4000),
      })
      .strict()
      .optional(),
    explanation: z
      .object({
        evidenceId,
        failure: z
          .object({
            index: z.number().int().min(1),
            of: z.number().int().min(1),
            file: z.string(),
            name: z.string(),
            message: z.string().max(2000),
          })
          .strict(),
        location: z
          .object({ path: z.string(), line: z.number().int(), column: z.number().int().nullable() })
          .strict()
          .nullable(),
        source: z
          .object({
            path: z.string(),
            commit: sha.nullable(),
            startLine: z.number().int().min(1),
            text: z.string().max(1600),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .optional(),
    // repro, check and verify: the versioned evidence envelope for the run.
    evidenceEnvelope: evidenceEnvelopeSchema.optional(),
    warnings: z.array(z.string()),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.exitCode !== cliExitCodes[result.verdict])
      ctx.addIssue({ code: "custom", message: "exitCode must match the verdict." });
    const envelope = result.evidenceEnvelope;
    if (!envelope) return;
    const add = (message: string) =>
      ctx.addIssue({ code: "custom", message, path: ["evidenceEnvelope", "claim"] });
    if (envelope.source !== "LOCAL_PROVISIONAL" || envelope.scope !== "FOCUSED")
      add("CLI evidence is local and focused on one selected test.");
    const passing = result.verdict === "PASSED" || result.verdict === "FIXED";
    if (passing && envelope.claim !== "FOCUSED_PASS")
      add(`A ${result.verdict} verdict needs a FOCUSED_PASS claim.`);
    if (
      envelope.claim === "FOCUSED_PASS" &&
      !["PASSED", "FIXED", "NOT_REPRODUCED"].includes(result.verdict)
    )
      add(`A FOCUSED_PASS claim can't back a ${result.verdict} verdict.`);
  });

export type CliResult = z.infer<typeof cliResultSchema>;
