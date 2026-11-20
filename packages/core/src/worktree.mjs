import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const shaPattern = /^[0-9a-f]{7,64}$/i;

async function git(cwd, args, options = {}) {
  const { stdout } = await run("git", args, {
    cwd,
    timeout: options.timeoutMs ?? 15000,
    env: options.env ?? process.env,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/** Build an environment that authenticates GitHub fetches without writing the token to disk. */
export function githubFetchEnv(token, env = process.env) {
  if (!token) return env;
  return {
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0:
      "AUTHORIZATION: basic " + Buffer.from("x-access-token:" + token).toString("base64"),
  };
}

/**
 * Make sure `commit` exists locally. Fetching is opt-in so local runs never
 * touch the network unless asked to.
 */
export async function ensureCommit(repo, commit, { fetch = false, token } = {}) {
  if (!shaPattern.test(commit)) throw Error("Use a full or abbreviated commit SHA.");
  try {
    return await git(repo, ["rev-parse", "--verify", "--quiet", commit + "^{commit}"]);
  } catch {
    if (!fetch)
      throw Error(
        `Commit ${commit} is not in this clone. Run \`git fetch origin ${commit}\` or allow fetching.`,
      );
  }
  try {
    await git(repo, ["fetch", "--no-tags", "origin", commit], { env: githubFetchEnv(token) });
    return await git(repo, ["rev-parse", "--verify", "--quiet", commit + "^{commit}"]);
  } catch (error) {
    throw Error(
      "Git could not fetch the selected commit. Confirm it is accessible from the origin remote.",
      { cause: error },
    );
  }
}

/**
 * Check out `commit` into a detached, throwaway worktree. The developer's own
 * working tree and index are never touched. Always call `remove()`.
 */
export async function checkoutCommit(repo, commit, options = {}) {
  const sha = await ensureCommit(repo, commit, options);
  const parent = await mkdtemp(join(options.tmpdir ?? tmpdir(), "traceyard-worktree-"));
  const path = join(parent, "checkout");
  try {
    await git(repo, ["worktree", "add", "--detach", "--force", path, sha], { timeoutMs: 120000 });
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw Error("Git could not create a checkout for " + sha.slice(0, 12) + ": " + error.message, {
      cause: error,
    });
  }
  let removed = false;
  return {
    path,
    sha,
    async remove() {
      if (removed) return;
      removed = true;
      await git(repo, ["worktree", "remove", "--force", path]).catch(() => {});
      await rm(parent, { recursive: true, force: true });
      await git(repo, ["worktree", "prune"]).catch(() => {});
    },
  };
}

/** Run `fn(checkout)` against an exact commit and always clean up afterwards. */
export async function withCommit(repo, commit, fn, options) {
  const checkout = await checkoutCommit(repo, commit, options);
  try {
    return await fn(checkout);
  } finally {
    await checkout.remove();
  }
}
