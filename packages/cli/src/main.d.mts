export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}
export interface ExecuteOptions {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  progress?: (message: string) => void;
}
export function main(
  argv: string[],
  io?: CliIo,
  options?: { env?: Record<string, string | undefined>; fetcher?: typeof fetch },
): Promise<number>;
/** Run one command and return its `--json` result. Never throws. */
export function execute(
  command: string,
  values?: Record<string, string | boolean | undefined>,
  testInput?: string,
  options?: ExecuteOptions,
): Promise<Record<string, unknown> & { verdict: string; exitCode: number; summary: string }>;
