export type RunnerName = "vitest" | "jest" | "pytest";
export interface RunnerAdapter {
  name: RunnerName;
  language: "javascript" | "python";
  supports: { replay: boolean; retryControl: boolean; caseSelector: boolean };
  matchesScript?: (command: string) => boolean;
  matchesFile?: (path: string) => boolean;
  args(input: { testArgument: string; output: string; plan: object }): string[];
  environment?: (env: Record<string, string | undefined>) => Record<string, string | undefined>;
  normalize(data: unknown, exitCode: number | null, context: object): object;
}
export const runnerAdapters: Record<RunnerName, RunnerAdapter>;
export function adapterForScript(command: string): RunnerAdapter | null;
export function adapterForFile(path: string): RunnerAdapter | null;
