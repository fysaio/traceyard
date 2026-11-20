import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function git(cwd, args, { timeoutMs = 15000 } = {}) {
  const { stdout } = await run("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

/** The top of the git repository that contains `cwd`. */
export async function repositoryRoot(cwd) {
  try {
    // Real paths, so Windows short names (RUNNER~1) and symlinked temp dirs
    // compare equal to the long path git reports.
    return await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    return null;
  }
}

/** Resolve a ref to its full SHA, or null if this clone does not have it. */
export async function resolveCommit(repo, ref) {
  try {
    return await git(repo, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"]);
  } catch {
    return null;
  }
}

/** Files that differ between two commits, as repository-relative paths. */
export async function changedFiles(repo, from, to) {
  const out = await git(repo, ["diff", "--name-only", "--no-renames", from, to], {
    timeoutMs: 60000,
  });
  return out ? out.split("\n").filter(Boolean) : [];
}

/** True when tracked files have uncommitted changes. Untracked files are ignored. */
export async function hasUncommittedChanges(repo) {
  const out = await git(repo, ["status", "--porcelain", "--untracked-files=no"]);
  return out.length > 0;
}

/** "owner/name" for the origin remote when it points at GitHub, otherwise null. */
export async function githubRepository(repo) {
  let url;
  try {
    url = await git(repo, ["remote", "get-url", "origin"]);
  } catch {
    return null;
  }
  const match = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  return match?.[1] ?? null;
}

/** Full SHA of HEAD, or null in a repository with no commits. */
export async function headCommit(repo) {
  return resolveCommit(repo, "HEAD");
}

/**
 * A file's contents at a commit (or in the working tree when commit is null).
 * Null when the file doesn't exist there or isn't inside the repository.
 */
export async function showFile(repo, commit, path) {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return null;
  try {
    if (commit) return await git(repo, ["show", `${commit}:${path}`], { timeoutMs: 15000 });
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    return await readFile(join(repo, path), "utf8");
  } catch {
    return null;
  }
}
