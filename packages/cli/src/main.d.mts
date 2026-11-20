export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}
export function main(
  argv: string[],
  io?: CliIo,
  options?: { env?: Record<string, string | undefined>; fetcher?: typeof fetch },
): Promise<number>;
