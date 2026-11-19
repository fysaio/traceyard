import type { InvestigationPlan, InvestigationReport } from "../shared/contracts/investigation-execution";
import type { RepositoryIndex } from "./repository-index.mjs";
export function sanitizeDiagnostic(value: unknown, max?: number): string;
export function runInvestigationPlan(workspace: string,index: RepositoryIndex,plan: InvestigationPlan,env: Record<string,string|undefined>): Promise<Omit<InvestigationReport,"requestId"|"runId"|"commit">>;
export function normalizeVitestReport(data: unknown, exitCode: number | null, root?: string): Pick<InvestigationReport,"status"|"counts"|"failures"|"truncated"|"message">;
export function selectTest(index: RepositoryIndex, question: string, testPath?: string): { test?: RepositoryIndex["files"][number]; reason?: string; candidates?: string[] };
export function runTargetedTest(workspace: string,index: RepositoryIndex,plan: InvestigationPlan,env: Record<string,string|undefined>): Promise<Omit<InvestigationReport,"requestId"|"runId"|"commit">>;
export function prepareTargetedTest(workspace: string, index: RepositoryIndex, plan: InvestigationPlan): Promise<{ reason: string } | { root: string; directory: string; file: string; runner: "vitest" | "jest"; command: InvestigationReport["command"] }>;
