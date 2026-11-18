import type {
  InvestigationPlan,
  InvestigationReport,
} from "../shared/contracts/investigation-execution";
export function replayVitest(
  root: string,
  invocation: { directory: string; script: string; testPath: string },
  plan: InvestigationPlan,
): Promise<Omit<InvestigationReport, "requestId" | "runId" | "commit">>;
