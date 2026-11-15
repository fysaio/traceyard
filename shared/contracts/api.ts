import type { WorkflowGraph } from "../workflow/graph";
import { z } from "zod";

import type { ErrorClass } from "../domain/errors";
import type { BackoffStrategy } from "../domain/retry";
import { RUN_STATUSES } from "../domain/status";
import type { StepStatus } from "../domain/status";
import { FAILURE_SCENARIOS, type FailureScenario } from "../workflow/document";

/* ------------------------------------------------------------------------- */
/* Requests                                                                   */
/* ------------------------------------------------------------------------- */

export const launchRunRequestSchema = z
  .object({
    workflowId: z.string().trim().min(1).max(80),
    projectId: z.string().trim().min(1).max(80).optional(),
    version: z.number().int().positive().optional(),
    input: z.unknown(),
    scenario: z.enum(FAILURE_SCENARIOS).default("success"),
  })
  .strict();

export type LaunchRunRequest = z.infer<typeof launchRunRequestSchema>;

export const runListQuerySchema = z
  .object({
    status: z.enum(RUN_STATUSES).optional(),
    workflowId: z.string().trim().max(80).optional(),
    projectId: z.string().trim().min(1).max(80).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const eventListQuerySchema = z
  .object({
    after: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

export const overviewQuerySchema = z
  .object({
    days: z.coerce.number().int().min(7).max(30).default(14),
  })
  .strict();

/* ------------------------------------------------------------------------- */
/* Responses                                                                  */
/* ------------------------------------------------------------------------- */

export interface ApiSuccess<T> {
  data: T;
  meta: { requestId: string };
}

export interface ApiFailure {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export interface ErrorView {
  class: ErrorClass;
  code: string;
  message: string;
  retryable: boolean;
  stepKey?: string;
  attempt?: number;
}

export interface WorkflowStepContract {
  key: string;
  name: string;
  ordinal: number;
  description: string;
  timeoutMs: number;
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    backoff: BackoffStrategy;
    maxDelayMs: number;
  };
}

export interface WorkflowSummary {
  graph?: WorkflowGraph | null;
  id: string;
  slug: string;
  name: string;
  description: string;
  version: number;
  steps: WorkflowStepContract[];
  createdAt: string;
}

export interface StepCounts {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export interface DispatchView {
  status: "PENDING" | "PUBLISHED" | "CLAIMED" | "FAILED" | "CANCELLED";
  attempts: number;
  lastError: string | null;
  publishedAt: string | null;
  claimedAt: string | null;
}

export interface RunSummary {
  id: string;
  workflow: {
    id: string;
    slug: string;
    name: string;
    version: number;
  };
  status: (typeof RUN_STATUSES)[number];
  triggerSource: "sandbox" | "api" | "retry";
  scenario: FailureScenario;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  queueDelayMs: number | null;
  stepCounts: StepCounts;
  error: ErrorView | null;
  parentRunId: string | null;
  retryOfRunId: string | null;
}

export interface AttemptView {
  number: number;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "ABANDONED";
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: ErrorView | null;
}

export interface StepView {
  id: string;
  key: string;
  name: string;
  ordinal: number;
  status: StepStatus;
  attemptCount: number;
  maxAttempts: number;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: ErrorView | null;
  attempts: AttemptView[];
}

export interface RunDetail extends RunSummary {
  input: unknown;
  output: unknown;
  correlationId: string;
  cancelRequestedAt: string | null;
  retryRunId: string | null;
  dispatch: DispatchView;
  steps: StepView[];
}

export interface EventView {
  id: string;
  seq: number;
  type: string;
  level: "info" | "warn" | "error";
  message: string;
  stepKey: string | null;
  attemptNumber: number | null;
  data: unknown;
  createdAt: string;
}

export interface RunListPage {
  items: RunSummary[];
  nextCursor: string | null;
}

export interface EventListPage {
  items: EventView[];
  nextCursor: number | null;
}

export interface LaunchRunResult {
  run: RunDetail;
  replayed: boolean;
  dispatch: DispatchView;
}

export interface CancelRunResult {
  runId: string;
  status: (typeof RUN_STATUSES)[number];
  accepted: boolean;
  message: string;
}

export interface RetryRunResult {
  originalRunId: string;
  run: RunDetail;
  dispatch: DispatchView;
}

export interface DurationStats {
  sampleSize: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface TrendPoint {
  date: string;
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface FailureClassCount {
  class: ErrorClass;
  count: number;
}

export interface SandboxStatus {
  enabled: boolean;
  circuitOpenUntil: string | null;
  globalRunsToday: number;
  globalDailyLimit: number;
  activeRuns: number;
  activeRunLimit: number;
  sessionRunsToday: number;
  sessionDailyLimit: number;
  sessionRunsThisHour: number;
  sessionHourlyLimit: number;
  retentionDays: number;
}

export interface OverviewPayload {
  generatedAt: string;
  totals: {
    runs: number;
    succeeded: number;
    failed: number;
    running: number;
    queued: number;
    cancelling: number;
    cancelled: number;
    successRate: number | null;
  };
  window: {
    days: number;
    runs: number;
    succeeded: number;
    failed: number;
  };
  trend: TrendPoint[];
  failureClasses: FailureClassCount[];
  recentRuns: RunSummary[];
  executionDuration: DurationStats;
  queueDelay: DurationStats;
  sandbox: SandboxStatus;
}

export interface StepDurationStats {
  stepKey: string;
  name: string;
  sampleSize: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface AnalyticsPayload {
  generatedAt: string;
  windowDays: number;
  trend: TrendPoint[];
  totals: OverviewPayload["totals"];
  failureClasses: FailureClassCount[];
  executionDuration: DurationStats;
  queueDelay: DurationStats;
  stepDurations: StepDurationStats[];
  throughputPerDay: number | null;
  sandbox: SandboxStatus;
}

export interface HealthPayload {
  status: "ok" | "degraded";
  version: string;
  environment: "development" | "production";
  timestamp: string;
  checks: {
    database: { status: "ok" | "error"; latencyMs: number | null };
    queue: { status: "configured" };
    workflow: { status: "configured" };
  };
}
