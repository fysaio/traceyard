export interface CommitOptions {
  fetch?: boolean;
  token?: string;
  tmpdir?: string;
}
export interface Checkout {
  path: string;
  sha: string;
  remove(): Promise<void>;
}
export function githubFetchEnv(
  token: string | undefined,
  env?: Record<string, string | undefined>,
): Record<string, string | undefined>;
export function ensureCommit(
  repo: string,
  commit: string,
  options?: CommitOptions,
): Promise<string>;
export function checkoutCommit(
  repo: string,
  commit: string,
  options?: CommitOptions,
): Promise<Checkout>;
export function withCommit<T>(
  repo: string,
  commit: string,
  fn: (checkout: Checkout) => Promise<T>,
  options?: CommitOptions,
): Promise<T>;
