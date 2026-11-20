import { z } from "zod";

// The `traceyard --json` output contract. Documented in docs/CLI.md. The local
// MCP server (#48) returns the same shapes. Additive changes keep
// schemaVersion 1; removing or renaming a field bumps it.

const sha = z.string().regex(/^[a-f0-9]{40}$/);
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
  "STILL_FAILING",
  "NEEDS_REVIEW",
  "INCONCLUSIVE",
  "BLOCKED",
  "ERROR",
] as const;

export const cliExitCodes = {
  REPRODUCED: 0,
  PASSED: 0,
  FIXED: 0,
  FAILING: 1,
  STILL_FAILING: 1,
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
    dependencies: z.enum(["none", "existing", "linked", "installed"]),
    message: z.string().max(600),
    output: z.string().max(4000).optional(),
  })
  .strict();

export const cliResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    command: z.enum(["repro", "check", "verify", "receipt"]).nullable(),
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
    warnings: z.array(z.string()),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.exitCode !== cliExitCodes[result.verdict])
      ctx.addIssue({ code: "custom", message: "exitCode must match the verdict." });
  });

export type CliResult = z.infer<typeof cliResultSchema>;
