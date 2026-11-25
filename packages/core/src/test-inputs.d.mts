export function isJavaScriptTestInput(path: string): boolean;
export function isPytestInput(path: string): boolean;
export function isTestInput(path: string): boolean;
export function scriptConfigPath(command: string): string | null;
export function runnerConfigDigest(input: {
  root: string;
  directory: string;
  pkg: { scripts?: Record<string, unknown>; jest?: unknown };
  script: string;
}): Promise<string>;
export function runnerConfigChange(
  baseline: { runnerConfig?: string | null } | null | undefined,
  candidate: { runnerConfig?: string | null } | null | undefined,
  directory?: string,
  changedFiles?: string[],
): { changed: string[]; unknown: boolean };
