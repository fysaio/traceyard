// Runs repository code as a separate, unprivileged operating-system user.
//
// The managed runner starts this agent as root with TRACEYARD_SANDBOX_USER set
// to `uid:gid`. Every repository process (install, build, test, application)
// is then started as that user. Because the agent and repository code no
// longer share a user, repository code cannot read the agent's environment
// (/proc/<pid>/environ), open its file descriptors, signal it, or trace it.
//
// When the variable is set, the boundary is required: the agent refuses to
// run repository code unless it can confirm the drop with a probe process.
import { spawnSync } from "node:child_process";
import { chown, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";

/** @typedef {{ uid: number, gid: number, home: string }} SandboxIdentity */

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<SandboxIdentity | null>}
 */
export async function sandboxIdentity(env = process.env) {
  const value = env.TRACEYARD_SANDBOX_USER;
  if (value === undefined || value === "") return null;
  const match = /^(\d{1,9}):(\d{1,9})$/.exec(value);
  if (!match) throw Error("TRACEYARD_SANDBOX_USER must be a numeric uid:gid.");
  const uid = Number(match[1]),
    gid = Number(match[2]);
  if (uid === 0 || gid === 0) throw Error("Repository code must not run as root.");
  if (process.platform === "win32" || process.getuid?.() !== 0)
    throw Error(
      "The runner must start as root to run repository code as a separate user. No repository commands were run.",
    );
  const home = await homeDirectory(uid);
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify([process.getuid(),process.geteuid(),process.getgid(),process.getegid(),process.getgroups()]))",
    ],
    { uid, gid, env: { HOME: home }, cwd: "/", encoding: "utf8", timeout: 10000 },
  );
  let observed;
  try {
    observed = JSON.parse(probe.stdout);
  } catch {
    observed = null;
  }
  const [ruid, euid, rgid, egid, groups] = observed ?? [];
  if (
    probe.status !== 0 ||
    ruid !== uid ||
    euid !== uid ||
    rgid !== gid ||
    egid !== gid ||
    !Array.isArray(groups) ||
    groups.some((group) => group !== gid)
  )
    throw Error(
      "Repository code could not be confirmed to run as a separate user. No repository commands were run.",
    );
  return { uid, gid, home };
}

async function homeDirectory(uid) {
  try {
    const passwd = await readFile("/etc/passwd", { encoding: "utf8", flag: "r" });
    for (const line of passwd.split("\n")) {
      const fields = line.split(":");
      if (Number(fields[2]) === uid && fields[5]?.startsWith("/")) return fields[5];
    }
  } catch {
    /* Fall back to a shared temporary directory. */
  }
  return tmpdir();
}

/**
 * Adds the sandbox identity to child-process options. Without a sandbox the
 * options are returned unchanged.
 * @template {{ env?: Record<string, string | undefined> }} T
 * @param {SandboxIdentity | null | undefined} sandbox
 * @param {T} options
 * @returns {T & { uid?: number, gid?: number }}
 */
export function sandboxed(sandbox, options) {
  if (sandbox || !sandbox) return options; // MUTATION
  return {
    ...options,
    uid: sandbox.uid,
    gid: sandbox.gid,
    env: { ...(options.env ?? process.env), HOME: sandbox.home },
  };
}

/** Gives the sandbox user ownership of a directory the agent created for it. */
export async function grantToSandbox(sandbox, path) {
  if (sandbox) await chown(path, sandbox.uid, sandbox.gid);
}

/**
 * Reads a file that repository code may have written, without following a
 * symbolic link it may have planted in place of the file.
 */
export function readUntrustedFile(path, encoding = "utf8") {
  return readFile(path, {
    encoding,
    flag: process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW,
  });
}
