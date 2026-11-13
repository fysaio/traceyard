import { describe, expect, it } from "vitest";

import {
  InvalidTransitionError,
  RUN_STATUSES,
  STEP_STATUSES,
  assertRunTransition,
  assertStepTransition,
  canTransitionRun,
  canTransitionStep,
  isActiveRunStatus,
  isRunStatus,
  isTerminalRunStatus,
} from "../../shared/domain/status";

describe("run state machine", () => {
  it("exposes exactly the documented statuses", () => {
    expect(RUN_STATUSES).toEqual([
      "QUEUED",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "CANCELLING",
      "CANCELLED",
    ]);
  });

  it("allows the happy path", () => {
    expect(canTransitionRun("QUEUED", "RUNNING")).toBe(true);
    expect(canTransitionRun("RUNNING", "SUCCEEDED")).toBe(true);
  });

  it("allows cooperative cancellation", () => {
    expect(canTransitionRun("QUEUED", "CANCELLED")).toBe(true);
    expect(canTransitionRun("RUNNING", "CANCELLING")).toBe(true);
    expect(canTransitionRun("CANCELLING", "CANCELLED")).toBe(true);
    expect(canTransitionRun("CANCELLING", "FAILED")).toBe(true);
  });

  it("never leaves a terminal status", () => {
    for (const terminal of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) {
      for (const target of RUN_STATUSES) {
        expect(canTransitionRun(terminal, target)).toBe(false);
      }
    }
  });

  it("rejects resuming a run from a terminal status", () => {
    expect(canTransitionRun("FAILED", "RUNNING")).toBe(false);
    expect(canTransitionRun("CANCELLED", "RUNNING")).toBe(false);
    expect(canTransitionRun("SUCCEEDED", "RUNNING")).toBe(false);
  });

  it("classifies statuses", () => {
    expect(isRunStatus("RUNNING")).toBe(true);
    expect(isRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("FAILED")).toBe(true);
    expect(isTerminalRunStatus("CANCELLING")).toBe(false);
    expect(isActiveRunStatus("QUEUED")).toBe(true);
    expect(isActiveRunStatus("CANCELLING")).toBe(true);
    expect(isActiveRunStatus("SUCCEEDED")).toBe(false);
  });

  it("throws a typed error for illegal transitions", () => {
    expect(() => assertRunTransition("SUCCEEDED", "RUNNING")).toThrow(InvalidTransitionError);
    try {
      assertRunTransition("SUCCEEDED", "RUNNING");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect((error as InvalidTransitionError).entity).toBe("run");
      expect((error as InvalidTransitionError).from).toBe("SUCCEEDED");
      expect((error as InvalidTransitionError).to).toBe("RUNNING");
    }
  });
});

describe("step state machine", () => {
  it("exposes exactly the documented statuses", () => {
    expect(STEP_STATUSES).toEqual([
      "PENDING",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "SKIPPED",
      "CANCELLED",
    ]);
  });

  it("supports skip-before-start and fail-after-start", () => {
    expect(canTransitionStep("PENDING", "SKIPPED")).toBe(true);
    expect(canTransitionStep("PENDING", "CANCELLED")).toBe(true);
    expect(canTransitionStep("RUNNING", "FAILED")).toBe(true);
    expect(canTransitionStep("RUNNING", "SUCCEEDED")).toBe(true);
  });

  it("does not allow a completed step to run again", () => {
    for (const terminal of ["SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED"] as const) {
      for (const target of STEP_STATUSES) {
        expect(canTransitionStep(terminal, target)).toBe(false);
      }
    }
  });

  it("throws a typed error for illegal transitions", () => {
    expect(() => assertStepTransition("SUCCEEDED", "RUNNING")).toThrow(InvalidTransitionError);
  });
});
