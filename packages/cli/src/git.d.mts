export function git(cwd: string, args: string[], options?: { timeoutMs?: number }): Promise<string>;
export function repositoryRoot(cwd: string): Promise<string | null>;
export function resolveCommit(repo: string, ref: string): Promise<string | null>;
export function changedFiles(repo: string, from: string, to: string): Promise<string[]>;
export function hasUncommittedChanges(repo: string): Promise<boolean>;
export function githubRepository(repo: string): Promise<string | null>;
export function headCommit(repo: string): Promise<string | null>;
export function showFile(repo: string, commit: string | null, path: string): Promise<string | null>;
export interface WorktreeSnapshot {
  /** SHA-256 over HEAD, the tracked diff and every hashed untracked file. */
  fingerprint: string;
  /** SHA-256 over HEAD and the tracked diff only. */
  tracked: string;
  /** Untracked, non-ignored path to git blob ID. */
  untracked: Map<string, string>;
  /** False when some untracked files could not be hashed. */
  complete: boolean;
}
export function worktreeSnapshot(repo: string): Promise<WorktreeSnapshot>;
export function worktreeChanged(before: WorktreeSnapshot, after: WorktreeSnapshot): boolean;
