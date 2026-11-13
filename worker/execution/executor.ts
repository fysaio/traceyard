import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStep } from "cloudflare:workers";

import type { ErrorClass } from "../../shared/domain/errors";
import { DomainError, serializeError, type SerializedError } from "../../shared/domain/errors";
import { isTerminalRunStatus, type RunStatus } from "../../shared/domain/status";
import {
  extractFromNormalized,
  faultToError,
  injectedFault,
  normalizeContent,
  validateDocumentInput,
  validateExtraction,
  verifyExtractionDigest,
  type DocumentExtraction,
  type DocumentInput,
  type DocumentStepKey,
  type FailureScenario,
  type NormalizedDocument,
} from "../../shared/workflow/document";
import { sha256Hex } from "../lib/crypto";
import { log, logError } from "../observability/logger";
import { getRunRow } from "../persistence/runs";
import { getStep, completeStep, failStepAttempt, startStepAttempt } from "../persistence/steps";
import { commitWorkflowOutput } from "../persistence/outputs";
import type { RunRow, StepRow } from "../persistence/rows";
import { getWorkflowRuntime, type WorkflowRuntime } from "../workflows/registry";
import { beginRun, finalizeRunCancelled, finalizeRunFailure, finalizeRunSuccess } from "./finalize";

interface ExecutionState {
  input: DocumentInput;
  normalized: NormalizedDocument;
  extraction: DocumentExtraction;
  digest: string;
}

export interface ExecutionOutcome {
  runId: string;
  status: RunStatus;
}

/**
 * Executes one Traceyard run inside a Cloudflare Workflow.
 *
 * Cloudflare provides durable step checkpointing, retry scheduling and
 * instance lifecycle management. Traceyard's D1 tables remain the system of
 * record for run and step state: every callback writes conditional transitions
 * and every step is safe to re-enter after a crash.
 */
export class RunExecutor {
  private readonly db: D1Database;
  private run: RunRow | null = null;
  private runtime: WorkflowRuntime | null = null;

  constructor(
    env: Env,
    private readonly runId: string,
    private readonly step: WorkflowStep,
  ) {
    this.db = env.DB;
  }

  async execute(): Promise<ExecutionOutcome> {
    const initialRun = await getRunRow(this.db, this.runId);
    if (initialRun === null) {
      throw new NonRetryableError(`Run ${this.runId} does not exist.`);
    }
    this.run = initialRun;

    if (isTerminalRunStatus(initialRun.status)) {
      return { runId: this.runId, status: initialRun.status };
    }
    if (initialRun.status === "CANCELLING") {
      await finalizeRunCancelled(this.db, this.runId);
      return { runId: this.runId, status: "CANCELLED" };
    }

    const workflowRow = await this.db
      .prepare(`SELECT slug FROM workflows WHERE id = ?`)
      .bind(initialRun.workflow_id)
      .first<{ slug: string }>();
    if (workflowRow === null) {
      await this.failRun(
        new NonRetryableError("The workflow definition for this run no longer exists."),
        "EXECUTION_INFRASTRUCTURE",
      );
      return { runId: this.runId, status: "FAILED" };
    }
    const runtime = getWorkflowRuntime(workflowRow.slug);
    if (runtime === null) {
      await this.failRun(
        new NonRetryableError(`No execution runtime exists for workflow "${workflowRow.slug}".`),
        "EXECUTION_INFRASTRUCTURE",
      );
      return { runId: this.runId, status: "FAILED" };
    }
    if (runtime.version !== initialRun.workflow_version) {
      await this.failRun(
        new NonRetryableError(
          `Workflow version ${initialRun.workflow_version} is not executable by runtime v${runtime.version}.`,
        ),
        "EXECUTION_INFRASTRUCTURE",
      );
      return { runId: this.runId, status: "FAILED" };
    }
    this.runtime = runtime;

    try {
      if (initialRun.status === "QUEUED") {
        const started = await beginRun(this.db, this.runId, initialRun.correlation_id);
        if (started.status === "CANCELLED" || started.status === "CANCELLING") {
          if (started.status === "CANCELLING") {
            await finalizeRunCancelled(this.db, this.runId);
          }
          return { runId: this.runId, status: "CANCELLED" };
        }
        if (started.status === "FAILED" || started.status === "SUCCEEDED") {
          return { runId: this.runId, status: started.status };
        }
      }

      this.run = (await getRunRow(this.db, this.runId)) ?? initialRun;

      const inputIntegrity = await sha256Hex(this.run.input_json);
      if (inputIntegrity !== this.run.input_hash) {
        throw new DomainError({
          errorClass: "EXECUTION_INFRASTRUCTURE",
          code: "INPUT_INTEGRITY_FAILED",
          message: "Persisted input failed its integrity check.",
        });
      }

      const state = await this.executeSteps();

      if (state === null) {
        return { runId: this.runId, status: "CANCELLED" };
      }

      const outputJson = JSON.stringify(state.extraction);
      const succeeded = await finalizeRunSuccess(this.db, this.runId, outputJson, {
        digest: state.digest,
      });
      if (!succeeded) {
        const current = await getRunRow(this.db, this.runId);
        if (current?.status === "CANCELLING") {
          await finalizeRunCancelled(this.db, this.runId);
          return { runId: this.runId, status: "CANCELLED" };
        }
        if (current !== null && isTerminalRunStatus(current.status)) {
          return { runId: this.runId, status: current.status };
        }
        throw new NonRetryableError(
          "Run could not transition to SUCCEEDED from its current state.",
        );
      }

      log("info", "run.succeeded", {
        runId: this.runId,
        correlationId: this.run.correlation_id,
        durationMs:
          this.run.started_at === null ? null : Date.now() - Date.parse(this.run.started_at),
      });
      return { runId: this.runId, status: "SUCCEEDED" };
    } catch (error) {
      return this.handleExecutionError(error);
    }
  }

  private async executeSteps(): Promise<ExecutionState | null> {
    if (this.run === null || this.runtime === null) {
      throw new Error("RunExecutor was not initialised.");
    }
    const input = validateDocumentInput(JSON.parse(this.run.input_json) as unknown);
    const scenario = this.run.scenario as FailureScenario;
    let state: ExecutionState = {
      input,
      normalized: normalizeContent(input),
      extraction: null as unknown as DocumentExtraction,
      digest: "",
    };

    for (const definition of this.runtime.steps) {
      if (await this.isCancellationRequested()) {
        await finalizeRunCancelled(this.db, this.runId);
        return null;
      }

      const stepKey = definition.key as DocumentStepKey;
      let snapshot: unknown = null;

      switch (stepKey) {
        case "validate-input":
          snapshot = input;
          break;
        case "normalize-content":
          snapshot = { title: input.title, document: input.document };
          break;
        case "extract-insights":
          snapshot = { title: input.title, normalizedText: state.normalized.text };
          break;
        case "validate-output":
          snapshot = state.extraction;
          break;
        case "persist-result":
          snapshot = { title: state.extraction.title, digest: state.extraction.digest };
          break;
      }

      const result = await this.executeStep(definition, stepKey, scenario, snapshot);

      switch (stepKey) {
        case "validate-input":
          // Validation output is the validated input; the state already holds it.
          break;
        case "normalize-content":
          state = { ...state, normalized: result as NormalizedDocument };
          break;
        case "extract-insights":
          state = { ...state, extraction: result as DocumentExtraction };
          break;
        case "validate-output":
          state = { ...state, extraction: result as DocumentExtraction };
          break;
        case "persist-result": {
          const committed = result as { outputJson: string; digest: string };
          state = { ...state, digest: committed.digest };
          break;
        }
      }
    }

    return state;
  }

  private async executeStep(
    definition: WorkflowRuntime["steps"][number],
    stepKey: DocumentStepKey,
    scenario: FailureScenario,
    inputSnapshot: unknown,
  ): Promise<unknown> {
    const existing = await getStep(this.db, this.runId, stepKey);
    if (existing === null) {
      throw new NonRetryableError(`Step row "${stepKey}" is missing for run ${this.runId}.`);
    }
    if (existing.status === "SUCCEEDED") {
      return parseStepOutput(existing);
    }
    if (
      existing.status === "FAILED" ||
      existing.status === "SKIPPED" ||
      existing.status === "CANCELLED"
    ) {
      throw new NonRetryableError(
        `Step "${stepKey}" is already in terminal state ${existing.status}.`,
      );
    }

    const config = {
      retries: {
        limit: Math.max(0, definition.maxAttempts - 1),
        // Cloudflare Workflows accepts a numeric retry delay in milliseconds,
        // matching the domain policy's stored unit.
        delay: definition.baseDelayMs,
        backoff: definition.backoff === "fixed" ? ("constant" as const) : definition.backoff,
      },
      timeout: definition.timeoutMs,
    };

    const resultJson = await this.step.do(stepKey, config, async (ctx): Promise<string> => {
      const attemptNumber = ctx.attempt;
      const start = await startStepAttempt(this.db, {
        runId: this.runId,
        stepId: existing.id,
        stepKey,
        attemptNumber,
        inputJson: inputSnapshot === null ? null : JSON.stringify(inputSnapshot),
      });

      if (start.state === "already_succeeded") {
        if (start.step === null) throw new NonRetryableError("Completed step row disappeared.");
        return JSON.stringify(parseStepOutput(start.step));
      }
      if (start.state === "terminal" || start.step === null) {
        throw new NonRetryableError(`Step "${stepKey}" cannot begin a new attempt.`);
      }

      try {
        const fault = injectedFault(scenario, stepKey, attemptNumber);
        if (fault !== null) throw faultToError(fault);

        const value = await this.computeStep(stepKey);
        const outputJson = JSON.stringify(value);
        const durationMs =
          start.step?.started_at == null
            ? null
            : Math.max(0, Date.now() - Date.parse(start.step.started_at));
        const completed = await completeStep(this.db, {
          runId: this.runId,
          stepId: existing.id,
          stepKey,
          attemptNumber,
          outputJson,
          eventMessage: `Step "${definition.name}" completed (attempt ${attemptNumber}).`,
          eventData: { durationMs },
        });
        if (!completed.changed) {
          if (completed.outputJson === null) {
            throw new NonRetryableError(`Step "${stepKey}" completed without a persisted output.`);
          }
          return completed.outputJson;
        }
        return outputJson;
      } catch (error) {
        const serialized = serializeError(error, { stepKey, attempt: attemptNumber });
        const isFinalAttempt = !serialized.retryable || attemptNumber >= definition.maxAttempts;
        await failStepAttempt(this.db, {
          runId: this.runId,
          stepId: existing.id,
          stepKey,
          stepName: definition.name,
          attemptNumber,
          error: serialized,
          isFinalAttempt,
        });
        if (!serialized.retryable) {
          throw new NonRetryableError(`${serialized.code}: ${serialized.message}`);
        }
        throw error;
      }
    });

    return JSON.parse(resultJson) as unknown;
  }

  private async computeStep(stepKey: DocumentStepKey): Promise<unknown> {
    if (this.run === null) throw new Error("Run not loaded.");
    const input = validateDocumentInput(JSON.parse(this.run.input_json) as unknown);

    switch (stepKey) {
      case "validate-input":
        return input;
      case "normalize-content":
        return normalizeContent(input);
      case "extract-insights": {
        const normalized = await this.getCompletedStep<NormalizedDocument>("normalize-content");
        return extractFromNormalized(input.title, normalized);
      }
      case "validate-output": {
        const extraction = await this.getCompletedStep<DocumentExtraction>("extract-insights");
        validateExtraction(extraction);
        await verifyExtractionDigest(extraction);
        return extraction;
      }
      case "persist-result": {
        const extraction = await this.getCompletedStep<DocumentExtraction>("validate-output");
        const outputJson = JSON.stringify(extraction);
        const committed = await commitWorkflowOutput(this.db, {
          runId: this.runId,
          digest: extraction.digest,
          outputJson,
        });
        return { outputJson: committed.outputJson, digest: extraction.digest };
      }
    }
  }

  private async getCompletedStep<T>(stepKey: DocumentStepKey): Promise<T> {
    const row = await getStep(this.db, this.runId, stepKey);
    if (row === null || row.status !== "SUCCEEDED" || row.output_json === null) {
      throw new DomainError({
        errorClass: "PERMANENT_APPLICATION",
        code: "STEP_DEPENDENCY_MISSING",
        message: `Required prerequisite step "${stepKey}" has not completed.`,
      });
    }
    return JSON.parse(row.output_json) as T;
  }

  private async isCancellationRequested(): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT status FROM runs WHERE id = ?`)
      .bind(this.runId)
      .first<{ status: RunStatus }>();
    return row?.status === "CANCELLING" || row?.status === "CANCELLED";
  }

  private async handleExecutionError(error: unknown): Promise<ExecutionOutcome> {
    const current = await getRunRow(this.db, this.runId);
    if (current === null) {
      logError("run.failure_state_missing", error, { runId: this.runId });
      throw error;
    }
    if (current.status === "CANCELLING" || current.status === "CANCELLED") {
      await finalizeRunCancelled(this.db, this.runId);
      return { runId: this.runId, status: "CANCELLED" };
    }
    if (isTerminalRunStatus(current.status)) {
      return { runId: this.runId, status: current.status };
    }

    const failedStep = await this.db
      .prepare(
        `SELECT * FROM execution_steps
          WHERE run_id = ? AND status = 'FAILED'
          ORDER BY ordinal DESC LIMIT 1`,
      )
      .bind(this.runId)
      .first<StepRow>();

    let serialized: SerializedError;
    if (failedStep?.error_json != null) {
      serialized = JSON.parse(failedStep.error_json) as SerializedError;
    } else {
      serialized = serializeError(error, { fallbackClass: "EXECUTION_INFRASTRUCTURE" });
    }

    const errorClass: ErrorClass = serialized.class;
    const message =
      failedStep !== null
        ? `Run failed in step "${failedStep.name}": ${serialized.message}`
        : `Run failed: ${serialized.message}`;

    const changed = await finalizeRunFailure(
      this.db,
      this.runId,
      JSON.stringify(serialized),
      errorClass,
      message,
    );
    logError("run.failed", error, {
      runId: this.runId,
      errorClass,
      errorCode: serialized.code,
      stepKey: serialized.stepKey ?? null,
      transitioned: changed,
    });

    return { runId: this.runId, status: "FAILED" };
  }

  private async failRun(error: unknown, fallbackClass: ErrorClass): Promise<void> {
    const serialized = serializeError(error, { fallbackClass });
    await finalizeRunFailure(
      this.db,
      this.runId,
      JSON.stringify(serialized),
      serialized.class,
      `Run failed: ${serialized.message}`,
    );
    logError("run.failed", error, { runId: this.runId, errorClass: serialized.class });
  }
}

function parseStepOutput(step: StepRow): unknown {
  if (step.output_json === null) {
    throw new NonRetryableError(`Completed step "${step.step_key}" has no stored output.`);
  }
  return JSON.parse(step.output_json) as unknown;
}
