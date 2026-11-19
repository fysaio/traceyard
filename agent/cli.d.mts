import type {
  InvestigationPlan,
  InvestigationReport,
} from "../shared/contracts/investigation-execution";
import type { DiscoveredOperation } from "./discovery.mjs";
export function scanDirectory(
  root: string,
): Promise<{ operations: DiscoveredOperation[]; filesScanned: number; warnings: string[] }>;
export function main(args?: string[]): Promise<void>;
export function runOriginalTest(
  root: string,
  plan: InvestigationPlan & { originalTest: NonNullable<InvestigationPlan["originalTest"]> },
  env: NodeJS.ProcessEnv,
  checkoutToken?: string,
): Promise<NonNullable<InvestigationReport["originalTest"]>>;
export function investigationJobSummary(
  origin: string,
  projectId: string | undefined,
  investigationId: string,
  report: InvestigationReport,
): string;
