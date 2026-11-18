import { cpSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, relative } from "node:path";
import { normalizeVitestReport, sanitizeDiagnostic } from "./test-report.mjs";
const config = JSON.parse(readFileSync("/recording/config.json", "utf8")),
  manifest = JSON.parse(readFileSync("/recording/manifest.json", "utf8")),
  started = Date.now();
let result,
  tail = "";
try {
  mkdirSync("/tmp/workspace", { recursive: true });
  cpSync("/source", "/tmp/workspace", {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const path = relative("/source", src),
        parts = path.split("/");
      if (
        parts.some(
          (p) =>
            p === ".git" || p === ".traceyard-runner" || p === ".dev.vars" || p.startsWith(".env"),
        )
      )
        return false;
      const stat = lstatSync(src);
      if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink())
        throw Error("Unsupported filesystem object in the replay snapshot.");
      return true;
    },
  });
  const env = {
    ...process.env,
    NODE_OPTIONS: "--import /opt/traceyard/record-fetch.mjs",
    TRACEYARD_REPLAY_FILE: "/recording/manifest.json",
    TRACEYARD_REPLAY_STATE: "/tmp/replay-events.jsonl",
    CI: "true",
    npm_config_cache: "/tmp/npm-cache",
  };
  for (const item of manifest.environment) {
    if (!/^(?:TRACEYARD|GITHUB|ACTIONS|OTEL)_/.test(item.name))
      env[item.name] =
        item.kind === "url"
          ? (item.protocol ?? "https:") + "//traceyard-replay.invalid/database"
          : "traceyard-replay-placeholder";
  }
  const output = "/tmp/reporter.json",
    directory = join("/tmp/workspace", config.directory),
    file = relative(directory, join("/tmp/workspace", config.testPath));

  const exitCode = await new Promise((done, reject) => {
    const child = spawn(
      "npm",
      [
        "run",
        config.script,
        "--",
        file,
        "--reporter=json",
        "--outputFile=" + output,
        "--fileParallelism=false",
        "--maxWorkers=1",
      ],
      { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (d) => {
      tail = (tail + d).slice(-5000);
    });
    child.stderr.on("data", (d) => {
      tail = (tail + d).slice(-5000);
    });
    child.on("error", reject);
    child.on("close", done);
  });
  const raw = readFileSync(output, "utf8");
  if (raw.length > 8_000_000) throw Error("The reporter exceeded the replay artifact budget.");
  result = {
    ...normalizeVitestReport(JSON.parse(raw), exitCode, "/tmp/workspace"),
    exitCode,
    durationMs: Date.now() - started,
    command: config,
    nodeVersion: process.version,
  };
  const events = (() => {
    try {
      return readFileSync("/tmp/replay-events.jsonl", "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  })();
  const reused = events.filter((e) => e.kind === "reused"),
    expected = new Map();
  for (const item of manifest.interactions)
    expected.set(item.signature, (expected.get(item.signature) ?? 0) + 1);
  for (const event of reused)
    expected.set(event.signature, (expected.get(event.signature) ?? 0) - 1);
  const diverged =
    events.some((e) => e.kind === "divergence") || [...expected.values()].some((n) => n !== 0);
  if (diverged) {
    result.status = "BLOCKED";
    result.message = "Replay diverged from retained interactions; no live fallback was allowed.";
    result.exitCode = null;
  }
  result.replay = {
    recordingId: config.recordingId,
    isolation: "docker-network-none",
    reusedRequests: reused.length,
    diverged,
  };
  delete result.command.recordingId;
} catch (error) {
  result = {
    status: "BLOCKED",
    counts: { passed: 0, failed: 0, skipped: 0 },
    failures: [],
    truncated: false,
    message: sanitizeDiagnostic(error.message + " " + tail, 2000),
    exitCode: null,
    durationMs: Date.now() - started,
    nodeVersion: process.version,
    command: { directory: config.directory, script: config.script, testPath: config.testPath },
    replay: {
      recordingId: config.recordingId,
      isolation: "docker-network-none",
      reusedRequests: 0,
      diverged: true,
    },
  };
}
process.stdout.write("TRACEYARD_REPLAY_RESULT=" + JSON.stringify(result) + "\n");
