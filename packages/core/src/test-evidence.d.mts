import type {
  InvestigationPlan,
  InvestigationReport,
} from "../../../shared/contracts/investigation-execution";
import type { RepositoryIndex } from "./repository-index.mjs";
import type { PackageManagerName } from "./package-manager.mjs";
export interface RunOptions {
  /** Replays a recorded run. Only the hosted runner provides it. */
  replay?: (
    root: string,
    command: InvestigationReport["command"],
    plan: InvestigationPlan,
  ) => Promise<Omit<InvestigationReport, "requestId" | "runId" | "commit">>;
  /** Force a package manager instead of detecting it from the repository. */
  packageManager?: PackageManagerName | { name: PackageManagerName; major: number | null };
}
export function sanitizeDiagnostic(value: unknown, max?: number): string;
export function runInvestigationPlan(
  workspace: string,
  index: RepositoryIndex,
  plan: InvestigationPlan,
  env: Record<string, string | undefined>,
  options?: RunOptions,
): Promise<Omit<InvestigationReport, "requestId" | "runId" | "commit">>;
export function normalizeVitestReport(
  data: unknown,
  exitCode: number | null,
  root?: string,
): Pick<InvestigationReport, "status" | "counts" | "failures" | "truncated" | "message">;
export function selectTest(
  index: RepositoryIndex,
  question: string,
  testPath?: string,
): { test?: RepositoryIndex["files"][number]; reason?: string; candidates?: string[] };
export function runTargetedTest(
  workspace: string,
  index: RepositoryIndex,
  plan: InvestigationPlan,
  env: Record<string, string | undefined>,
  options?: RunOptions,
): Promise<Omit<InvestigationReport, "requestId" | "runId" | "commit">>;
export function prepareTargetedTest(
  workspace: string,
  index: RepositoryIndex,
  plan: InvestigationPlan,
): Promise<
  | { reason: string }
  | {
      directory: string;
      file: string;
      runner: "vitest" | "jest" | "pytest";
      requirements?: string;
      root?: string;
      command: InvestigationReport["command"];
    }
>;
