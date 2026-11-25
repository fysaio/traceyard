import { z } from "zod";
import { repositoryPathSchema } from "./repository-index";
import { recordingManifestSchema } from "./recordings";
export const pytestCaseSchema = z
  .string()
  .max(240)
  .regex(/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:\[[^\p{Cc}]{0,150}\])?$/u);

export const investigationPlanSchema = z
  .object({
    investigationId: z.string().regex(/^inv_[a-f0-9]{32}$/),
    requestId: z.string().regex(/^req_[a-f0-9]{32}$/),
    question: z.string().min(3).max(1000),
    testPath: repositoryPathSchema.optional(),
    testCase: pytestCaseSchema.optional(),
    changedFiles: z.array(repositoryPathSchema).max(100).optional(),
    maxTestFiles: z.number().int().min(1).max(5).optional(),
    captureInteractions: z.boolean().optional(),
    flakeCandidate: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    replayRecording: z
      .object({ id: z.string().regex(/^rcd_[a-f0-9]{32}$/), manifest: recordingManifestSchema })
      .strict()
      .optional(),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    timeoutMs: z.number().int().min(1000).max(180000).default(120000),
  })
  .strict();
export const investigationReportSchema = z
  .object({
    requestId: z.string().regex(/^req_[a-f0-9]{32}$/),
    runId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    status: z.enum(["SUCCEEDED", "FAILED", "BLOCKED"]),
    command: z
      .object({
        directory: repositoryPathSchema,
        script: z.string().max(80),
        testPath: repositoryPathSchema.nullable(),
        testCase: pytestCaseSchema.optional(),
      })
      .strict(),
    counts: z
      .object({
        passed: z.number().int().min(0),
        failed: z.number().int().min(0),
        skipped: z.number().int().min(0),
      })
      .strict(),
    failures: z
      .array(
        z
          .object({
            file: z.string().max(240),
            name: z.string().max(250),
            message: z.string().max(1500),
          })
          .strict(),
      )
      .max(8),
    message: z.string().max(2000),
    // Digest of the runner configuration the run used (script, jest key, named config).
    runnerConfig: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    durationMs: z.number().int().min(0).max(600000),
    exitCode: z.number().int().nullable(),
    truncated: z.boolean(),
    nodeVersion: z.string().max(40),
    output: z.string().max(4000).optional(),
    flakeRuns: z
      .array(
        z
          .object({
            commit: z.string().regex(/^[a-f0-9]{40}$/),
            attempt: z.number().int().min(1).max(3),
            status: z.enum(["SUCCEEDED", "FAILED", "BLOCKED"]),
            durationMs: z.number().int().min(0).max(120000),
            message: z.string().max(1400),
          })
          .strict(),
      )
      .length(6)
      .optional(),
    checks: z
      .array(
        z
          .object({
            testPath: repositoryPathSchema,
            status: z.enum(["SUCCEEDED", "FAILED", "BLOCKED"]),
          })
          .strict(),
      )
      .max(5)
      .optional(),
    coverage: z
      .object({ omittedTests: z.number().int().min(0) })
      .strict()
      .optional(),
    replay: z
      .object({
        recordingId: z.string().regex(/^rcd_[a-f0-9]{32}$/),
        isolation: z.literal("docker-network-none"),
        reusedRequests: z.number().int().min(0),
        diverged: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((r, c) => {
    if (r.flakeRuns) return;
    if (r.status === "SUCCEEDED" && r.replay?.diverged)
      c.addIssue({ code: "custom", message: "A divergent replay cannot establish success." });
    if (r.status === "SUCCEEDED" && (r.exitCode !== 0 || r.counts.failed || !r.counts.passed))
      c.addIssue({
        code: "custom",
        message: "A successful report needs a passing executed test and no failure.",
      });
    if (r.status === "FAILED" && r.exitCode === 0)
      c.addIssue({ code: "custom", message: "A failed report cannot claim a successful process." });
  });
export type InvestigationPlan = z.infer<typeof investigationPlanSchema>;
export type InvestigationReport = z.infer<typeof investigationReportSchema>;

export function flakinessOutcome(runs: NonNullable<InvestigationReport["flakeRuns"]>) {
  const groups = [runs.slice(0, 3), runs.slice(3)];
  const counts = groups.map((group) => ({
    passed: group.filter((r) => r.status === "SUCCEEDED").length,
    failed: group.filter((r) => r.status === "FAILED").length,
    blocked: group.filter((r) => r.status === "BLOCKED").length,
  }));
  const mixed = counts.some((c) => c.passed && c.failed);
  const incomplete = counts.some((c) => c.blocked);
  return {
    counts,
    label: mixed || incomplete ? "Inconclusive" : "Flakiness check complete",
    summary: mixed
      ? "Inconclusive. Outcomes flipped at the same commit. Review the individual attempts."
      : incomplete
        ? "Inconclusive. Some attempts could not complete. Open their output before retrying."
        : `${counts.map((count) => `${count.failed ? "failed" : "passed"} 3/3`).join(", then ")}; no flakiness observed in 3 runs per commit.`,
  };
}
