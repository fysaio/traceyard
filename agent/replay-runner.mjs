import { access, chmod, cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { sanitizeDiagnostic } from "./test-report.mjs";
function command(args, timeout = 120000) {
  return new Promise((done, reject) => {
    const child = spawn("/usr/bin/docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let text = "",
      timedOut = false;
    child.stdout.on("data", (d) => {
      text = (text + d).slice(-50000);
    });
    child.stderr.on("data", (d) => {
      text = (text + d).slice(-50000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, text, timedOut });
    });
  });
}
export async function replayVitest(root, invocation, plan) {
  const started = Date.now(),
    recording = plan.replayRecording;
  const blocked = (message) => ({
    status: "BLOCKED",
    counts: { passed: 0, failed: 0, skipped: 0 },
    failures: [],
    truncated: false,
    message: sanitizeDiagnostic(message, 2000),
    durationMs: Date.now() - started,
    exitCode: null,
    nodeVersion: process.version,
    command: invocation,
  });
  if (process.platform !== "linux")
    return blocked("Isolated replay currently requires the supported Linux Docker executor.");
  try {
    await access("/usr/bin/docker");
  } catch {
    return blocked("Replay isolation is unavailable. No live fallback was attempted.");
  }
  if (root.includes(",") || root.includes(":"))
    return blocked("The snapshot path is unsupported by the isolation mount format.");
  const context = await mkdtemp(join(tmpdir(), "traceyard-replay-image-")),
    snapshot = await mkdtemp(join(tmpdir(), "traceyard-replay-source-")),
    data = await mkdtemp(join(tmpdir(), "traceyard-replay-data-")),
    name = "traceyard-replay-" + randomUUID();
  try {
    const files = [
        "interaction-format.mjs",
        "record-fetch.mjs",
        "replay-entry.mjs",
        "test-report.mjs",
      ],
      digest = createHash("sha256");
    for (const file of files) {
      const source = fileURLToPath(new URL("./" + file, import.meta.url));
      digest.update(await readFile(source));
      await cp(source, join(context, file));
    }
    const dockerfile = fileURLToPath(new URL("./replay.Dockerfile", import.meta.url));
    digest.update(await readFile(dockerfile));
    await cp(dockerfile, join(context, "Dockerfile"));
    const image = "traceyard-replay:" + digest.digest("hex").slice(0, 20),
      present = await command(["image", "inspect", image], 10000);
    if (present.code !== 0) {
      const built = await command(["build", "--quiet", "--tag", image, context], 180000);
      if (built.code !== 0)
        return blocked("The replay image could not be prepared within its budget.");
    }
    await cp(root, snapshot, {
      recursive: true,
      verbatimSymlinks: true,
      filter: async (source) => {
        const parts = relative(root, source).split("/");
        if (
          parts.some(
            (p) =>
              [
                ".git",
                ".traceyard-runner",
                ".dev.vars",
                ".npmrc",
                ".aws",
                ".ssh",
                ".config",
                ".wrangler",
              ].includes(p) || p.startsWith(".env"),
          )
        )
          return false;
        const stat = await lstat(source);
        if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink())
          throw Error("Unsupported filesystem object in replay snapshot.");
        return true;
      },
    });
    await chmod(snapshot, 0o755);
    await chmod(data, 0o755);
    await writeFile(join(data, "manifest.json"), JSON.stringify(recording.manifest), {
      mode: 0o644,
    });
    await writeFile(
      join(data, "config.json"),
      JSON.stringify({ ...invocation, recordingId: recording.id }),
      { mode: 0o644 },
    );
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--cpus=1",
      "--memory=2g",
      "--tmpfs",
      "/tmp:rw,nosuid,size=1536m",
      "--mount",
      `type=bind,source=${snapshot},target=/source,readonly`,
      "--mount",
      `type=bind,source=${data},target=/recording,readonly`,
      image,
    ];
    const run = await command(args, plan.timeoutMs),
      line = run.text.split("\n").find((l) => l.startsWith("TRACEYARD_REPLAY_RESULT="));
    if (!line)
      return blocked(
        run.timedOut
          ? "The isolated replay exceeded its time budget."
          : "The isolated executor did not produce a complete result.",
      );
    const result = JSON.parse(line.slice("TRACEYARD_REPLAY_RESULT=".length));
    return { ...result, durationMs: Date.now() - started };
  } catch (error) {
    return blocked("Replay isolation failed: " + sanitizeDiagnostic(error.message));
  } finally {
    try {
      await command(["rm", "--force", name], 10000);
    } catch {
      /* The container may already be removed. */
    }
    await rm(snapshot, { recursive: true, force: true });
    await rm(context, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}
