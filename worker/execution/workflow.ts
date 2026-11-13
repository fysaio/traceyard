import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { RunExecutor, type ExecutionOutcome } from "./executor";

export interface RunWorkflowParams {
  runId: string;
  correlationId: string;
}

/**
 * The Cloudflare Workflows entrypoint. All durable execution logic lives in
 * RunExecutor so it can be reasoned about and tested independently of the
 * managed Workflow runtime.
 */
export class RunExecutionWorkflow extends WorkflowEntrypoint<Env, RunWorkflowParams> {
  override async run(
    event: WorkflowEvent<RunWorkflowParams>,
    step: WorkflowStep,
  ): Promise<ExecutionOutcome> {
    const runId = event.payload?.runId;
    if (typeof runId !== "string" || !/^run_[a-f0-9]{32}$/u.test(runId)) {
      throw new Error("Invalid run identifier in workflow payload.");
    }
    const executor = new RunExecutor(this.env, runId, step);
    return executor.execute();
  }
}
