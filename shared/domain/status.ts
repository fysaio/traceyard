/**
 * The run and step state machines.
 *
 * These transition tables are the authoritative definition of which state
 * changes are legal. Persistence code only performs conditional updates whose
 * `WHERE` clauses mirror these transitions, so a stale or duplicate worker
 * cannot move a terminal record back into an active state.
 */

export const RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLING",
  "CANCELLED",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLING"],
  CANCELLING: ["CANCELLED", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export const STEP_STATUSES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
] as const;

const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  PENDING: ["RUNNING", "SKIPPED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  SKIPPED: [],
  CANCELLED: [],
};

export const ATTEMPT_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED", "ABANDONED"] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export function isActiveRunStatus(status: RunStatus): boolean {
  return status === "QUEUED" || status === "RUNNING" || status === "CANCELLING";
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly entity: "run" | "step";
  readonly from: string;
  readonly to: string;

  constructor(entity: "run" | "step", from: string, to: string) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new InvalidTransitionError("run", from, to);
  }
}

export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!canTransitionStep(from, to)) {
    throw new InvalidTransitionError("step", from, to);
  }
}
