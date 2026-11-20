import type { InvestigationReport } from "../../../shared/contracts/investigation-execution";
import type { PackageManagerName } from "./package-manager.mjs";

export * from "./repository-index.mjs";
export * from "./test-evidence.mjs";
export * from "./discovery.mjs";
export * from "./runners.mjs";
export * from "./package-manager.mjs";
export * from "./worktree.mjs";
export * from "./ci-link.mjs";
export function summarizeCommandFailure(output: string, phase: string, result: unknown): string;
export function isPytestFile(path: string): boolean;
export function validPytestCase(value: unknown): boolean;

export interface LocalTestOptions {
  repo: string;
  testPath?: string;
  testCase?: string;
  question?: string;
  commit?: string;
  changedFiles?: string[];
  maxTestFiles?: number;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  packageManager?: PackageManagerName;
  fetch?: boolean;
  token?: string;
  beforeRun?: (directory: string) => Promise<void> | void;
}
export type LocalTestReport = Omit<InvestigationReport, "requestId" | "runId" | "commit"> & {
  commit: string | null;
  snapshotId: string;
};
export function runLocalTest(options: LocalTestOptions): Promise<LocalTestReport>;
