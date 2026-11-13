import type {
  AttemptView,
  DispatchView,
  ErrorView,
  EventView,
  RunDetail,
  RunSummary,
  StepCounts,
  StepView,
} from "../../shared/contracts/api";
import type { ErrorClass } from "../../shared/domain/errors";
import { serializeError } from "../../shared/domain/errors";
import { durationMs } from "../lib/time";
import type {
  AttemptRow,
  DispatchRow,
  DispatchSummaryRow,
  EventRow,
  RunWithWorkflowRow,
  StepRow,
  StepStatusCountRow,
} from "./rows";

export function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function parseError(value: string | null): ErrorView | null {
  if (value === null) return null;
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const errorClass = record["class"];
  if (typeof errorClass !== "string") return null;
  return {
    class: errorClass as ErrorClass,
    code: typeof record["code"] === "string" ? record["code"] : "UNKNOWN",
    message: typeof record["message"] === "string" ? record["message"] : "Unknown error",
    retryable: record["retryable"] === true,
    ...(typeof record["stepKey"] === "string" ? { stepKey: record["stepKey"] } : {}),
    ...(typeof record["attempt"] === "number" ? { attempt: record["attempt"] } : {}),
  };
}

export function errorFromUnknown(error: unknown, stepKey?: string, attempt?: number): ErrorView {
  const serialized = serializeError(error, {
    ...(stepKey === undefined ? {} : { stepKey }),
    ...(attempt === undefined ? {} : { attempt }),
  });
  return {
    class: serialized.class,
    code: serialized.code,
    message: serialized.message,
    retryable: serialized.retryable,
    ...(serialized.stepKey === undefined ? {} : { stepKey: serialized.stepKey }),
    ...(serialized.attempt === undefined ? {} : { attempt: serialized.attempt }),
  };
}

export function emptyStepCounts(): StepCounts {
  return { total: 0, pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0 };
}

export function stepCountsFromRows(rows: StepStatusCountRow[]): StepCounts {
  const counts = emptyStepCounts();
  for (const row of rows) {
    const count = Number(row.count);
    counts.total += count;
    switch (row.status) {
      case "PENDING":
        counts.pending += count;
        break;
      case "RUNNING":
        counts.running += count;
        break;
      case "SUCCEEDED":
        counts.succeeded += count;
        break;
      case "FAILED":
        counts.failed += count;
        break;
      case "SKIPPED":
        counts.skipped += count;
        break;
      case "CANCELLED":
        counts.cancelled += count;
        break;
    }
  }
  return counts;
}

export function toRunSummary(row: RunWithWorkflowRow, counts: StepCounts): RunSummary {
  return {
    id: row.id,
    workflow: {
      id: row.workflow_id,
      slug: row.workflow_slug,
      name: row.workflow_name,
      version: row.workflow_version,
    },
    status: row.status,
    triggerSource: row.trigger_source,
    scenario: row.scenario,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: durationMs(row.started_at, row.completed_at),
    queueDelayMs: durationMs(row.created_at, row.started_at),
    stepCounts: counts,
    error: parseError(row.error_json),
    parentRunId: row.parent_run_id,
    retryOfRunId: row.retry_of_run_id,
  };
}

export function toAttemptView(row: AttemptRow): AttemptView {
  return {
    number: row.attempt_number,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: durationMs(row.started_at, row.completed_at),
    error: parseError(row.error_json),
  };
}

export function toStepView(row: StepRow, attempts: AttemptRow[]): StepView {
  return {
    id: row.id,
    key: row.step_key,
    name: row.name,
    ordinal: row.ordinal,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: durationMs(row.started_at, row.completed_at),
    input: parseJson(row.input_json),
    output: parseJson(row.output_json),
    error: parseError(row.error_json),
    attempts: attempts
      .filter((attempt) => attempt.step_id === row.id)
      .sort((left, right) => left.attempt_number - right.attempt_number)
      .map(toAttemptView),
  };
}

export function toDispatchView(row: DispatchRow | DispatchSummaryRow | null): DispatchView {
  if (row === null) {
    return {
      status: "PENDING",
      attempts: 0,
      lastError: null,
      publishedAt: null,
      claimedAt: null,
    };
  }
  return {
    status: row.status,
    attempts: row.attempt_count,
    lastError: row.last_error,
    publishedAt: row.published_at,
    claimedAt: row.claimed_at,
  };
}

export function toRunDetail(
  row: RunWithWorkflowRow,
  counts: StepCounts,
  steps: StepRow[],
  attempts: AttemptRow[],
  dispatch: DispatchRow | null,
): RunDetail {
  return {
    ...toRunSummary(row, counts),
    input: parseJson(row.input_json),
    output: parseJson(row.output_json),
    correlationId: row.correlation_id,
    cancelRequestedAt: row.cancel_requested_at,
    retryRunId: row.retry_run_id,
    dispatch: toDispatchView(dispatch),
    steps: steps
      .slice()
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((step) => toStepView(step, attempts)),
  };
}

export function toEventView(row: EventRow): EventView {
  return {
    id: String(row.seq),
    seq: row.seq,
    type: row.type,
    level: row.level,
    message: row.message,
    stepKey: row.step_key,
    attemptNumber: row.attempt_number,
    data: parseJson(row.data_json),
    createdAt: row.created_at,
  };
}
