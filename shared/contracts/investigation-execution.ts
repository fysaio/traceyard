import { z } from "zod";
import { repositoryPathSchema } from "./repository-index";
export const investigationPlanSchema = z
  .object({
    investigationId: z.string().regex(/^inv_[a-f0-9]{32}$/),
    requestId: z.string().regex(/^req_[a-f0-9]{32}$/),
    question: z.string().min(3).max(1000),
    testPath: repositoryPathSchema.optional(),
    changedFiles: z.array(repositoryPathSchema).max(100).optional(),
    maxTestFiles: z.number().int().min(1).max(5).optional(),
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
    durationMs: z.number().int().min(0).max(300000),
    exitCode: z.number().int().nullable(),
    truncated: z.boolean(),
    nodeVersion: z.string().max(40),
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
  })
  .strict()
  .superRefine((r, c) => {
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
