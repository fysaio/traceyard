import { DomainError } from "../../shared/domain/errors";
import { graphSchema, graphLayers } from "../../shared/workflow/graph";
import { DOCUMENT_WORKFLOW, validateDocumentInput } from "../../shared/workflow/document";
import type { WorkflowCatalogEntry } from "../persistence/catalog";

export interface WorkflowRuntime {
  slug: string;
  version: number;
  steps: readonly {
    key: string;
    name: string;
    ordinal: number;
    maxAttempts: number;
    timeoutMs: number;
    baseDelayMs: number;
    backoff: "fixed" | "linear" | "exponential";
    maxDelayMs: number;
  }[];
  /** Validates untrusted input and returns the exact JSON that will be persisted. */
  validateInput(input: unknown): unknown;
}

const DOCUMENT_RUNTIME: WorkflowRuntime = {
  slug: DOCUMENT_WORKFLOW.slug,
  version: DOCUMENT_WORKFLOW.version,
  steps: DOCUMENT_WORKFLOW.steps.map((step) => ({
    key: step.key,
    name: step.name,
    ordinal: step.ordinal,
    maxAttempts: step.retry.maxAttempts,
    timeoutMs: step.timeoutMs,
    baseDelayMs: step.retry.baseDelayMs,
    backoff: step.retry.backoff,
    maxDelayMs: step.retry.maxDelayMs,
  })),
  validateInput: (input) => validateDocumentInput(input),
};

/**
 * Only workflows implemented in this Worker are executable. A database catalog
 * row alone cannot introduce new code paths or arbitrary execution.
 */
const RUNTIMES = new Map<string, WorkflowRuntime>([[DOCUMENT_RUNTIME.slug, DOCUMENT_RUNTIME]]);

export function getWorkflowRuntime(slug: string): WorkflowRuntime | null {
  return RUNTIMES.get(slug) ?? null;
}

export function assertCatalogMatchesRuntime(entry: WorkflowCatalogEntry): WorkflowRuntime {
  if (entry.version.graph_json) {
    const graph = graphSchema.parse(JSON.parse(entry.version.graph_json));
    return {
      slug: entry.workflow.slug,
      version: entry.version.version,
      steps: graphLayers(graph)
        .flat()
        .map((n, i) => ({
          key: n.id,
          name: n.name,
          ordinal: i + 1,
          maxAttempts: 1,
          timeoutMs: n.type === "model" ? 120000 : n.type === "http" ? 30000 : 10000,
          baseDelayMs: 0,
          backoff: "fixed" as const,
          maxDelayMs: 0,
        })),
      validateInput: (value) => {
        if (value === undefined)
          throw new DomainError({
            errorClass: "VALIDATION",
            code: "INPUT_REQUIRED",
            message: "Provide an input JSON value.",
            retryable: false,
          });
        return value;
      },
    };
  }
  const runtime = getWorkflowRuntime(entry.workflow.slug);
  if (runtime === null) {
    throw new Error(`Workflow "${entry.workflow.slug}" is registered in D1 but has no runtime.`);
  }
  if (runtime.version !== entry.version.version) {
    throw new Error(
      `Workflow "${entry.workflow.slug}" version mismatch: runtime v${runtime.version}, catalog v${entry.version.version}.`,
    );
  }
  const catalogSteps = entry.summary.steps.map((step) => ({
    key: step.key,
    name: step.name,
    ordinal: step.ordinal,
    description: step.description,
    timeoutMs: step.timeoutMs,
    retry: step.retry,
  }));
  const runtimeSteps = DOCUMENT_WORKFLOW.steps.map((step) => ({
    key: step.key,
    name: step.name,
    ordinal: step.ordinal,
    description: step.description,
    timeoutMs: step.timeoutMs,
    retry: step.retry,
  }));
  if (JSON.stringify(catalogSteps) !== JSON.stringify(runtimeSteps)) {
    throw new Error(
      `Workflow "${entry.workflow.slug}" manifest drift: D1 catalog does not match the code definition.`,
    );
  }
  return runtime;
}
