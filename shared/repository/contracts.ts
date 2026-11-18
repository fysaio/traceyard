import { z } from "zod";
import { testResultSchema } from "./workspace";
import { sourceFlowSchema } from "./source-flow";
const path = z
  .string()
  .min(1)
  .max(240)
  .refine((v) => !v.startsWith("/") && !v.split("/").includes("..") && !v.includes("\\"));
export const operationSchema = z
  .object({
    id: z.string().min(1).max(400),
    name: z.string().min(1).max(200),
    kind: z.enum(["http", "job"]),
    file: path,
    line: z.number().int().min(1),
    calls: z.array(z.string().max(150)).max(12),
    sourceFlow: sourceFlowSchema.optional(),
    evidence: z.literal("source"),
  })
  .strict();
export const reportSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    sha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    phase: z.enum(["discovery", "install", "build", "test", "complete"]),
    status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"]),
    message: z.string().max(500),
    operations: z.array(operationSchema).max(100).optional(),
    filesScanned: z.number().int().min(0).max(10000).optional(),
    warnings: z.array(z.string().max(300)).max(20).optional(),
    testResults: z.array(testResultSchema).max(30).optional(),
  })
  .strict();
export type RepositoryReport = z.infer<typeof reportSchema>;
export interface RepositoryRecord {
  ci_setup_json?: string | null;
  scan_id?: string | null;
  project_id: string;
  repository_id: number | null;
  full_name: string;
  installation_id: number | null;
  default_branch: string | null;
  commit_sha: string | null;
  status: string;
  scan_json: string | null;
  scan_progress_json?: string | null;
  last_error: string | null;
  setup_pr_url: string | null;
  runner_enabled: number;
  check_setup_state:
    | "NOT_STARTED"
    | "PREPARING"
    | "AWAITING_MERGE"
    | "READY"
    | "QUEUED"
    | "FAILED"
    | "MERGING"
    | "BLOCKED";
  check_setup_error: string | null;
  check_setup_updated_at: string | null;
  last_dispatch_at: string | null;
  updated_at: string;
}
export interface RepositoryJob {
  id: string;
  project_id: string;
  commit_sha: string | null;
  source: string;
  phase: string;
  status: string;
  events_json: string;
  github_url: string | null;
  updated_at: string;
}
