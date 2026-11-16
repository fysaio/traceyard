import { z } from "zod";
import type { RepositoryRecord, RepositoryJob } from "./contracts";
export const runnerConfigSchema = z
  .object({
    directory: z
      .string()
      .trim()
      .max(160)
      .default(".")
      .refine(
        (v) =>
          v === "." ||
          (/^[A-Za-z0-9_./-]+$/.test(v) && !v.startsWith("/") && !v.split("/").includes("..")),
      ),
    startScript: z
      .string()
      .trim()
      .max(80)
      .regex(/^[A-Za-z0-9:_-]*$/)
      .default(""),
    port: z.number().int().min(1024).max(65535).default(3000),
  })
  .strict();
export type RunnerConfig = z.infer<typeof runnerConfigSchema>;
export const testCaseSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    path: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine(
        (v) => v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") && !/[\r\n]/.test(v),
        "Use a relative request path beginning with /.",
      ),
    body: z.unknown().optional(),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    responsePath: z
      .string()
      .max(160)
      .default("")
      .refine(
        (v) => !v.split(".").some((k) => ["__proto__", "constructor", "prototype"].includes(k)),
      ),
    expectedValue: z.unknown().optional(),
    captureResponse: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) => !value.responsePath || Object.prototype.hasOwnProperty.call(value, "expectedValue"),
    "Provide an expected JSON value when checking a response field.",
  );
export type TestCaseInput = z.infer<typeof testCaseSchema>;
export interface SavedTestCase extends TestCaseInput {
  id: string;
  operationKey: string;
  updatedAt: string;
}
export interface Operation {
  key: string;
  name: string;
  kind: string;
  file: string | null;
  line: number | null;
  calls: string[];
  evidence: "source" | "recorded" | "linked";
  runtimeNames: string[];
  runs: number;
  failed: number;
  lastRunAt: string | null;
  testCases: number;
}
export interface ApplicationRun {
  source?: "application" | "managed";
  id: string;
  name: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  steps: number;
  attributes: Record<string, unknown>;
  checkId: string | null;
  commit: string | null;
  operationKey?: string;
}
export interface Catalog {
  project: { id: string; name: string };
  repository: RepositoryRecord | null;
  operations: Operation[];
  runs: ApplicationRun[];
  jobs: RepositoryJob[];
  managedRuns?: ApplicationRun[];
  config: RunnerConfig;
  warnings: string[];
  filesScanned: number;
}
export interface TestResult {
  caseId: string;
  name: string;
  operationKey: string;
  traceId: string;
  status: "SUCCEEDED" | "FAILED";
  durationMs: number;
  responseStatus: number | null;
  checks: { name: string; passed: boolean }[];
  responsePreview?: string;
  error?: string;
}
export const testResultSchema = z
  .object({
    caseId: z.string().max(100),
    name: z.string().max(100),
    operationKey: z.string().max(100),
    traceId: z.string().regex(/^[a-f0-9]{32}$/),
    status: z.enum(["SUCCEEDED", "FAILED"]),
    durationMs: z.number().min(0).max(180000),
    responseStatus: z.number().int().min(100).max(599).nullable(),
    checks: z.array(z.object({ name: z.string().max(200), passed: z.boolean() })).max(5),
    responsePreview: z.string().max(2500).optional(),
    error: z.string().max(500).optional(),
  })
  .strict();
