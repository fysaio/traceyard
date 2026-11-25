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

const MAX_UNTRACKED = 2000;

const gitBuffer = (repo, args) =>
  run("git", args, {
    cwd: repo,
    timeout: 60000,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "buffer",
  }).then(({ stdout }) => stdout);

/**
 * Snapshot of the working tree a `check` runs against: HEAD, the diff of
 * tracked files against HEAD (staged and unstaged), and the blob IDs of
 * untracked files that aren't ignored. The same tree always gives the same
 * fingerprint, and any edit to a tracked or untracked file changes it.
 * `complete` is false when some untracked files could not be hashed.
 */
export async function worktreeSnapshot(repo) {
  const { createHash } = await import("node:crypto");
  const head = (await resolveCommit(repo, "HEAD")) ?? "unborn";
  const diff = await gitBuffer(repo, [
    "diff",
    "HEAD",
    "--binary",
    "--no-ext-diff",
    "--no-color",
  ]).catch(
    // No HEAD yet: every tracked file is staged, so diff the index instead.
    () => gitBuffer(repo, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-color"]),
  );
  const tracked = createHash("sha256")
    .update("head\0" + head + "\0diff\0")
    .update(diff)
    .digest("hex");
  const listed = (
    await gitBuffer(repo, ["ls-files", "--others", "--exclude-standard", "-z"])
  ).toString("utf8");
  const names = listed.split("\0").filter(Boolean).sort();
  // hash-object reads one path per line, so a name with a newline can't be hashed.
  const hashed = names.filter((path) => !path.includes("\n")).slice(0, MAX_UNTRACKED);
  const untracked = new Map();
  if (hashed.length) {
    const ids = await new Promise((done, fail) => {
      const child = execFile(
        "git",
        ["hash-object", "--no-filters", "--stdin-paths"],
        { cwd: repo, timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => (error ? fail(error) : done(stdout.trim().split("\n"))),
      );
      child.stdin.end(hashed.join("\n") + "\n");
    });
    hashed.forEach((path, index) => untracked.set(path, ids[index] ?? ""));
  }
  const hash = createHash("sha256").update("tracked\0" + tracked + "\0untracked\0" + names.length);
  for (const [path, id] of untracked) hash.update("\0" + path + "\0" + id);
  return {
    fingerprint: hash.digest("hex"),
    tracked,
    untracked,
    complete: hashed.length === names.length,
  };
}

/**
 * True when `after` no longer matches the tree `before` described: a tracked
 * file changed, or an untracked file that existed before was edited or
 * removed. New untracked files are ignored, because test runners create
 * caches (__pycache__, coverage) in repositories that don't ignore them.
 */
export const worktreeChanged = (before, after) =>
  before.tracked !== after.tracked ||
  [...before.untracked].some(([path, id]) => after.untracked.get(path) !== id);
