#!/usr/bin/env node
import { readdir, readFile, lstat, appendFile, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, basename, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { discoverFile } from "../packages/core/src/discovery.mjs";
import { summarizeCommandFailure } from "../packages/core/src/failure-summary.mjs";
import { buildRecording } from "./recording.mjs";
import { indexRepository } from "../packages/core/src/repository-index.mjs";
import {
  prepareTargetedTest,
  runInvestigationPlan,
  runTargetedTest,
  sanitizeDiagnostic,
} from "../packages/core/src/test-evidence.mjs";
import { createHash } from "node:crypto";
import { pytestEnvironment } from "../packages/core/src/pytest.mjs";
import { replayVitest } from "./replay-runner.mjs";
import { parseEnv } from "node:util";
import {
  LOCAL_ENV_FILE_KEYS,
  startTelemetryRelay,
  untrustedEnvironment,
} from "./telemetry-relay.mjs";

// The hosted runner installs with `npm ci` only, and replays recordings in Docker.
const hostedRunOptions = { replay: replayVitest, packageManager: "npm" };

export async function scanDirectory(root) {
  const operations = [],
    warnings = [];
  let filesScanned = 0;
  const ignored = new Set([
    "node_modules",
    "vendor",
    "dist",
    "build",
    ".git",
    ".next",
    "coverage",
    ".traceyard-runner",
    ".venv",
  ]);
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ignored.has(entry.name) || entry.name.startsWith(".env"))
        continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (
        /\.[cm]?[jt]sx?$/.test(entry.name) &&
        !/\.(?:test|spec|d)\.[jt]s$/.test(entry.name)
      ) {
        if (filesScanned >= 10000) {
          if (!warnings.includes("Source file limit reached."))
            warnings.push("Source file limit reached.");
          return;
        }
        if ((await lstat(file)).size > 64000) {
          warnings.push("Skipped large file: " + relative(root, file));
          continue;
        }
        const found = discoverFile(
          relative(root, file).split("\\").join("/"),
          await readFile(file, "utf8"),
        );
        filesScanned++;
        operations.push(...found.operations);
        if (found.warning) warnings.push(found.warning);
      }
    }
  }
  await walk(root);
  if (operations.length > 100) warnings.push("Dashboard discovery is limited to 100 operations.");
  return { operations: operations.slice(0, 100), filesScanned, warnings: warnings.slice(0, 20) };
}
function execute(program, args, options, phase, timeoutMs = 180000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, {
      ...options,
      stdio: ["inherit", "pipe", "pipe"],
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
    });
    let output = "";
    const capture = (stream, destination) => {
      stream.on("data", (chunk) => {
        destination.write(chunk);
        output = (output + chunk.toString()).slice(-131072);
      });
    };
    capture(child.stdout, process.stdout);
    capture(child.stderr, process.stderr);
    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
      reject(
        new Error(
          summarizeCommandFailure(
            output,
            phase,
            `${Math.floor(timeoutMs / 1000)} second time limit`,
          ),
        ),
      );
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", () => {
      if (process.platform !== "win32")
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* Group already stopped. */
        }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else reject(new Error(summarizeCommandFailure(output, phase, signal ?? code)));
    });
  });
}
async function findInstallRoot(workspaceRoot, packageDirectory) {
  for (let directory = packageDirectory; ; directory = dirname(directory)) {
    try {
      const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
      const workspace = relative(directory, packageDirectory).split("\\").join("/");
      if (!workspace || lock.packages?.[workspace]) return directory;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (directory === workspaceRoot) return null;
  }
}
function ensureRevision(root, commit, token) {
  const options = { cwd: root, stdio: "ignore" };
  try {
    execFileSync("git", ["cat-file", "-e", commit + "^{commit}"], options);
  } catch {
    const env = { ...process.env };
    if (token) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      env.GIT_CONFIG_VALUE_0 =
        "AUTHORIZATION: basic " + Buffer.from("x-access-token:" + token).toString("base64");
    }
    try {
      execFileSync("git", ["fetch", "--no-tags", "origin", commit], {
        ...options,
        env,
        timeout: 15000,
      });
    } catch {
      throw Error(
        "GitHub could not fetch the selected commit. Confirm it is accessible in the connected repository.",
      );
    }
  }
}
export async function runFlakiness(root, plan, env, checkoutToken) {
  const started = Date.now(),
    budget = 7 * 60000;
  const temporary = await mkdtemp(join(tmpdir(), "traceyard-flakiness-"));
  const flakeRuns = [];
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "ignore", timeout: 15000 });
  try {
    for (const [side, commit] of [plan.commit, plan.flakeCandidate].entries()) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const attemptStarted = Date.now();
        const checkout = join(temporary, `${side}-${attempt}`);
        let added = false;
        let status, message;
        try {
          if (budget - (Date.now() - started) < 1000)
            throw Error("The flakiness check reached its run budget before this attempt.");
          ensureRevision(root, commit, checkoutToken);
          git(["worktree", "add", "--detach", checkout, commit]);
          added = true;
          const index = await indexRepository(checkout);
          const prepared = await prepareTargetedTest(checkout, index, plan);
          if (prepared.reason) throw Error(prepared.reason);
          if (prepared.runner !== "vitest")
            throw Error("The flakiness check requires Vitest at both commits.");
          const installRoot = await findInstallRoot(checkout, prepared.directory);
          if (!installRoot)
            throw Error("The test package or npm workspace needs a package-lock.json.");
          const remaining = () => Math.max(1000, budget - (Date.now() - started));
          await execute(
            process.platform === "win32" ? "npm.cmd" : "npm",
            ["ci"],
            { cwd: installRoot, env },
            "install",
            Math.min(45000, remaining()),
          );
          const result = await runTargetedTest(
            checkout,
            index,
            { ...plan, timeoutMs: Math.min(45000, remaining()) },
            env,
            hostedRunOptions,
          );
          status = result.status === "FAILED" && !result.counts.failed ? "BLOCKED" : result.status;
          message = [result.message, result.failures[0]?.name, result.failures[0]?.message]
            .filter(Boolean)
            .join("\n");
        } catch (error) {
          status = "BLOCKED";
          message = error.message;
        } finally {
          if (added) await rm(checkout, { recursive: true, force: true });
        }
        flakeRuns.push({
          commit,
          attempt,
          status,
          message: sanitizeDiagnostic(message, 1400),
          durationMs: Math.min(120000, Date.now() - attemptStarted),
        });
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
    git(["worktree", "prune"]);
  }
  return {
    status: "SUCCEEDED",
    command: { directory: ".", script: "", testPath: plan.testPath },
    counts: {
      passed: flakeRuns.filter((run) => run.status === "SUCCEEDED").length,
      failed: flakeRuns.filter((run) => run.status === "FAILED").length,
      skipped: flakeRuns.filter((run) => run.status === "BLOCKED").length,
    },
    failures: [],
    message: "Flakiness check finished. Open the individual attempts for the observed results.",
    durationMs: Date.now() - started,
    exitCode: 0,
    truncated: false,
    nodeVersion: process.version,
    flakeRuns,
  };
}
export async function main(args = process.argv.slice(2)) {
  const [command = "help", directory = "."] = args;
  let root = resolve(directory);
  if (command === "record-browser") {
    const { browserRecordCommand } = await import("./browser-record.mjs");
    await browserRecordCommand(args.slice(1));
    return;
  }
  if (command === "setup-browser") {
    const { browserSetupCommand } = await import("./browser-setup.mjs");
    await browserSetupCommand(args.slice(1));
    return;
  }
  if (command === "compare-browser" || command === "browser-fixtures") {
    const { browserCompareCommand, browserFixturesCommand } = await import("./browser-journey.mjs");
    const run = command === "compare-browser" ? browserCompareCommand : browserFixturesCommand;
    await run(args.slice(1));
    return;
  }
  if (command === "help" || !["scan", "connect", "run"].includes(command)) {
    console.log(
      "Traceyard: scan [directory], connect [directory], run [directory], compare-browser <journey.json> <baseline SHA> <candidate SHA>, record-browser <local URL> <journey.json>, setup-browser <build directory>.",
    );
    return;
  }
  if (command === "scan") {
    console.log(JSON.stringify(await scanDirectory(root), null, 2));
    return;
  }
  // `.env.traceyard` is repository content. Hosted runs never read it, and a
  // local run accepts only connection settings that are not already set.
  if (process.env.GITHUB_ACTIONS !== "true" && !process.env.TRACEYARD_MANAGED_RUN_ID) {
    let values = {};
    try {
      values = parseEnv(await readFile(join(root, ".env.traceyard"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const name of LOCAL_ENV_FILE_KEYS)
      if (values[name] !== undefined && process.env[name] === undefined)
        process.env[name] = values[name];
  }
  const rawOrigin = process.env.TRACEYARD_ORIGIN;
  if (!rawOrigin) throw Error("Set TRACEYARD_ORIGIN to your Traceyard server URL.");
  const url = new URL(rawOrigin);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    (!["https:"].includes(url.protocol) &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
  )
    throw Error("Use an HTTPS server origin, or localhost for local development.");
  const origin = url.origin,
    isActions = process.env.GITHUB_ACTIONS === "true";
  const checkoutToken = isActions ? process.env.TRACEYARD_GITHUB_FETCH_TOKEN : undefined;
  delete process.env.TRACEYARD_GITHUB_FETCH_TOKEN;
  const managedId = process.env.TRACEYARD_MANAGED_RUN_ID;
  if (
    managedId &&
    (!/^managed_[a-f0-9]{32}$/.test(managedId) ||
      !/^[a-f0-9]{40}$/.test(process.env.TRACEYARD_COMMIT_SHA ?? ""))
  )
    throw Error("The managed runner snapshot is invalid.");
  const id =
    managedId ??
    (isActions
      ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
      : "local-" + randomUUID());
  let sha = managedId ? process.env.TRACEYARD_COMMIT_SHA : null;
  try {
    if (!managedId)
      sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
  } catch {
    /* An uncommitted local directory is supported. */
  }
  let cachedCredential = null,
    credentialAt = 0;
  async function credential() {
    if (cachedCredential && Date.now() - credentialAt < 60000) return cachedCredential;
    if (managedId) {
      if (!process.env.TRACEYARD_RUN_TOKEN) throw Error("The managed check credential is missing.");
      return process.env.TRACEYARD_RUN_TOKEN;
    }
    if (!isActions) {
      if (!process.env.TRACEYARD_KEY) throw Error("Set TRACEYARD_KEY in the server environment.");
      return process.env.TRACEYARD_KEY;
    }
    const tokenUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
    tokenUrl.searchParams.set("audience", origin);
    const result = await fetch(tokenUrl, {
      headers: { Authorization: "Bearer " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
      signal: AbortSignal.timeout(10000),
    });
    if (!result.ok) throw Error("GitHub OIDC requires id-token: write in the workflow.");
    cachedCredential = (await result.json()).value;
    credentialAt = Date.now();
    return cachedCredential;
  }
  async function send(path, body) {
    const response = await fetch(origin + "/api/v1/" + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + (await credential()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      let info;
      try {
        info = await response.json();
      } catch {
        /* The receiver may return a non-JSON error. */
      }
      throw Error(info?.error?.message ?? `Traceyard rejected the report (${response.status}).`);
    }
  }
  let currentPhase = "discovery";
  const report = (phase, status, message, extra = {}) => {
    currentPhase = phase;
    console.log(`Traceyard: ${phase} — ${message}`);
    return send("repository-runs", { id, sha, phase, status, message, ...extra }).then(async () => {
      if (isActions && process.env.GITHUB_STEP_SUMMARY)
        try {
          await appendFile(
            process.env.GITHUB_STEP_SUMMARY,
            `- **${phase} · ${status}** — ${message}\n`,
          );
        } catch {
          console.warn("GitHub summary could not be updated.");
        }
    });
  };
  if (!isActions && !managedId) await send("repository/register", { name: basename(root) });
  let completed = false;
  const manifestResponse = await fetch(
    origin +
      "/api/v1/repository/configuration" +
      (process.env.TRACEYARD_RUN_REQUEST
        ? "?request=" +
          encodeURIComponent(process.env.TRACEYARD_RUN_REQUEST) +
          "&run=" +
          encodeURIComponent(id)
        : args.includes("--case")
          ? "?case=" +
            encodeURIComponent(args[args.indexOf("--case") + 1] ?? "") +
            "&run=" +
            encodeURIComponent(id)
          : ""),
    {
      headers: {
        Authorization: "Bearer " + (await credential()),
        "X-Traceyard-Runner-Protocol": "3",
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!manifestResponse.ok)
    throw Error(
      "Project test settings could not be loaded. Check the server version and selected case.",
    );
  const manifest = (await manifestResponse.json()).data;
  const workspaceRoot = await realpath(root);
  root = await realpath(resolve(root, manifest.config.directory));
  const configuredPath = relative(workspaceRoot, root);
  if (
    configuredPath.startsWith("..") ||
    isAbsolute(configuredPath) ||
    !(await lstat(root)).isDirectory()
  )
    throw Error("The configured application directory is not inside this project.");
  let repositoryIndex, pytestSandbox, relay;
  try {
    const desired = manifest.investigation?.commit;
    if (manifest.investigation?.flakeCandidate) {
      if (!isActions || !desired || !manifest.investigation.testPath)
        throw Error(
          "Flakiness checks require the hosted GitHub runner and two selected revisions.",
        );
      const env = { ...untrustedEnvironment(process.env), CI: "true" };
      const result = await runFlakiness(workspaceRoot, manifest.investigation, env, checkoutToken);
      await send(
        "investigations/" + encodeURIComponent(manifest.investigation.investigationId) + "/report",
        { ...result, requestId: manifest.investigation.requestId, runId: id, commit: desired },
      );
      await report("complete", "SUCCEEDED", "Flakiness attempts retained.");
      return;
    }
    if (desired && desired !== sha) {
      if (!/^[a-f0-9]{40}$/.test(desired)) throw Error("Invalid candidate revision.");
      if (!isActions && !managedId)
        throw Error(
          "Use an isolated checkout at the requested candidate revision; Traceyard will not change your working checkout.",
        );
      ensureRevision(workspaceRoot, desired, checkoutToken);
      execFileSync("git", ["checkout", "--detach", desired], {
        cwd: workspaceRoot,
        stdio: "ignore",
      });
      sha = desired;
    }
    if (manifest.investigation && !isActions && !managedId) {
      try {
        execFileSync("git", ["diff", "--quiet", "HEAD"], { cwd: workspaceRoot, stdio: "ignore" });
      } catch {
        sha = null;
        throw Error(
          "The working tree differs from its commit. Verification requires an immutable candidate checkout.",
        );
      }
    }
    console.log("Traceyard: discovering source entry points…");
    if (manifest.capabilities?.repositoryIndex) {
      const index = (repositoryIndex = await indexRepository(workspaceRoot));
      const snapshotId = createHash("sha256")
        .update((sha ?? "working-tree") + index.snapshotId)
        .digest("hex");
      await send("repository/index", {
        action: "begin",
        manifest: {
          snapshotId,
          commit: sha,
          packages: index.packages,
          fileCount: index.files.length,
          coverage: index.coverage,
        },
      });
      let batch = [];
      for (const file of index.files) {
        if (
          batch.length &&
          (batch.length === 20 || Buffer.byteLength(JSON.stringify([...batch, file])) > 24000)
        ) {
          await send("repository/index", { action: "files", snapshotId, files: batch });
          batch = [];
        }
        batch.push(file);
      }
      if (batch.length)
        await send("repository/index", { action: "files", snapshotId, files: batch });
      await send("repository/index", { action: "complete", snapshotId });
    }
    await report("discovery", "RUNNING", "Reading source files.");
    const discovered = await scanDirectory(root);
    for (const op of discovered.operations)
      op.file = relative(workspaceRoot, join(root, op.file)).split("\\").join("/");
    discovered.operations = discovered.operations.filter((op) => op.file.length <= 240);

    // Keep reports within the API body limit without quietly dropping the coverage warning.
    while (Buffer.byteLength(JSON.stringify(discovered)) > 26000 && discovered.operations.length) {
      discovered.operations.pop();
      if (!discovered.warnings.includes("Source index was bounded to fit the upload limit."))
        discovered.warnings.push("Source index was bounded to fit the upload limit.");
    }
    await report(
      "discovery",
      "SUCCEEDED",
      `Read ${discovered.filesScanned} source files; found ${discovered.operations.length} supported entry points.`,
      discovered,
    );
    if (command === "connect") {
      await report("complete", "SKIPPED", "Source discovery complete. Runtime tests have not run.");
      completed = true;
      console.log("Connected. Open the project in Traceyard.");
      return;
    }
    let pkg,
      packageDirectory = root,
      focusedRunner,
      focusedRequirements;
    if (manifest.investigation) {
      repositoryIndex ??= await indexRepository(workspaceRoot);
      const prepared = await prepareTargetedTest(
        workspaceRoot,
        repositoryIndex,
        manifest.investigation,
      );
      if (prepared.reason) throw new Error(prepared.reason);
      packageDirectory = prepared.directory;
      focusedRunner = prepared.runner;
      focusedRequirements = prepared.requirements;
    } else {
      try {
        pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      } catch {
        await report("complete", "SKIPPED", "This runner needs an npm project to execute tests.");
        completed = true;
        return;
      }
      if (
        !manifest.cases.length &&
        !pkg.scripts?.build &&
        (!pkg.scripts?.test || /no test specified/.test(pkg.scripts.test))
      ) {
        await report(
          "complete",
          "SKIPPED",
          "No build or tests configured. Source discovery is available; no application commands were run.",
        );
        completed = true;
        return;
      }
    }
    const env = untrustedEnvironment(process.env);
    await report("install", "RUNNING", "Installing project dependencies.");
    let pytestPython;
    if (focusedRunner === "pytest") {
      const python = process.platform === "win32" ? "python.exe" : "python3";
      pytestSandbox = await mkdtemp(join(tmpdir(), "traceyard-pytest-"));
      const options = { cwd: packageDirectory, env: pytestEnvironment(env, true) };
      await execute(python, ["-I", "-m", "venv", pytestSandbox], options, "install");
      pytestPython =
        process.platform === "win32"
          ? join(pytestSandbox, "Scripts", "python.exe")
          : join(pytestSandbox, "bin", "python");
      await execute(
        pytestPython,
        [
          "-I",
          "-m",
          "pip",
          "--isolated",
          "--disable-pip-version-check",
          "install",
          "--only-binary=:all:",
          "--retries",
          "1",
          "--timeout",
          "20",
          "-r",
          focusedRequirements,
        ],
        options,
        "install",
      );
    } else {
      const installRoot = await findInstallRoot(workspaceRoot, packageDirectory);
      if (!installRoot) {
        const message =
          "A package-lock.json is required in this application or its npm workspace root.";
        if (manifest.investigation) throw new Error(message);
        await report("complete", "SKIPPED", message);
        completed = true;
        return;
      }
      const replaying = Boolean(manifest.investigation?.replayRecording);
      const installEnv = replaying
        ? Object.fromEntries(
            Object.entries(env).filter(([name]) =>
              ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "CI"].includes(name),
            ),
          )
        : env;
      await execute(
        process.platform === "win32" ? "npm.cmd" : "npm",
        replaying ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] : ["ci"],
        { cwd: installRoot, env: installEnv },
        "install",
      );
    }
    await report("install", "SUCCEEDED", "Dependencies installed.");
    if (pkg?.scripts?.build && !manifest.cases.length && !manifest.investigation) {
      await report("build", "RUNNING", "Running the existing build script.");
      await execute(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["run", "build"],
        {
          cwd: root,
          env,
        },
        "build",
      );
      await report("build", "SUCCEEDED", "Build completed.");
    } else
      await report(
        "build",
        "SKIPPED",
        manifest.cases.length
          ? "Starting the selected application directly for its request test."
          : manifest.investigation
            ? "Running the selected test directly."
            : "No build script configured.",
      );
    if (
      !manifest.cases.length &&
      !manifest.investigation &&
      (!pkg.scripts?.test || /no test specified/.test(pkg.scripts.test))
    ) {
      await report("test", "SKIPPED", "No tests configured.");
      await report("complete", "SKIPPED", "Discovery completed; no tests configured.");
      completed = true;
      return;
    }
    await report(
      "test",
      "RUNNING",
      pytestPython
        ? "Running the selected Pytest test."
        : "Running the existing test script with supported Node.js tracing.",
    );
    const preload = fileURLToPath(new URL("./register.cjs", import.meta.url));
    const esmPreload = new URL("./esm-register.mjs", import.meta.url).href;
    // Instrumented tests export spans to a loopback relay in this process; the
    // reporting credential never enters their environment.
    relay = pytestPython
      ? null
      : await startTelemetryRelay({
          target: origin + "/api/v1/otlp/v1/traces",
          credential,
        });
    const testEnv = pytestPython
      ? { ...pytestEnvironment(env), CI: "true", TRACEYARD_PYTEST_PYTHON: pytestPython }
      : {
          ...env,
          CI: "true",
          TRACEYARD_RUN_ID: id,
          NODE_OPTIONS: `--require ${JSON.stringify(preload)} --import ${JSON.stringify(esmPreload)}`,
          OTEL_SERVICE_NAME: basename(root),
          OTEL_RESOURCE_ATTRIBUTES: `traceyard.run.id=${id}`,
          OTEL_TRACES_EXPORTER: "otlp",
          OTEL_TRACES_SAMPLER: "always_on",
          OTEL_METRICS_EXPORTER: "none",
          OTEL_LOGS_EXPORTER: "none",
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: relay.endpoint,
          OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "32",
          OTEL_BSP_SCHEDULE_DELAY: "200",
          OTEL_NODE_RESOURCE_DETECTORS: "env,process",
          OTEL_EXPORTER_OTLP_TIMEOUT: "3000",
        };
    if (manifest.investigation) {
      const plan = manifest.investigation;
      const capture =
        plan.captureInteractions && !plan.replayRecording && focusedRunner === "vitest"
          ? await mkdtemp(join(tmpdir(), "traceyard-capture-"))
          : null;
      const captureFile = capture ? join(capture, "interactions.jsonl") : null;
      const focused = await runInvestigationPlan(
        workspaceRoot,
        repositoryIndex ?? (await indexRepository(workspaceRoot)),
        plan,
        captureFile
          ? {
              ...testEnv,
              TRACEYARD_CAPTURE_FILE: captureFile,
              TRACEYARD_RECORDING_EXCLUDE_ORIGIN: relay.origin,
              NODE_OPTIONS:
                testEnv.NODE_OPTIONS +
                " --import " +
                JSON.stringify(new URL("./record-fetch.mjs", import.meta.url).href),
            }
          : testEnv,
        hostedRunOptions,
      );
      if (plan.captureInteractions && focusedRunner !== "vitest")
        focused.message =
          focused.message.slice(0, 1850) + " Interaction recording requires Vitest.";
      try {
        if (captureFile && focused.command.testPath) {
          const recording = await buildRecording(captureFile, sha, focused.command.testPath);
          await send("investigations/" + encodeURIComponent(plan.investigationId) + "/recordings", {
            requestId: plan.requestId,
            runId: id,
            manifest: recording,
          });
        }
      } catch {
        focused.message =
          focused.message.slice(0, 1750) +
          " Interaction capture could not be retained; replay is unavailable.";
      }
      if (capture) await rm(capture, { recursive: true, force: true });
      await send("investigations/" + encodeURIComponent(plan.investigationId) + "/report", {
        ...focused,
        requestId: plan.requestId,
        runId: id,
        commit: sha,
      });
      await report(
        "test",
        focused.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
        focused.message.slice(0, 500),
      );
      await report(
        "complete",
        focused.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
        "Focused investigation completed; inspect retained structured evidence.",
      );
      completed = true;
      process.exitCode = focused.status === "SUCCEEDED" ? 0 : 1;
      return;
    }
    let testResults = [];
    if (manifest.cases.length) {
      if (!pkg.scripts?.[manifest.config.startScript])
        throw Error("The configured startup script is missing from package.json.");
      const temporary = await mkdtemp(join(tmpdir(), "traceyard-check-"));
      const resultFile = join(temporary, "results.json");
      // Feed test data through stdin, never command-line arguments or log output.
      try {
        await new Promise((done, reject) => {
          const child = spawn(
            process.execPath,
            [fileURLToPath(new URL("./http-check.mjs", import.meta.url))],
            {
              cwd: root,
              env: {
                ...testEnv,
                NODE_OPTIONS: "",
                TRACEYARD_PRELOAD: testEnv.NODE_OPTIONS,
                TRACEYARD_RESULTS_FILE: resultFile,
              },
              stdio: ["pipe", "inherit", "inherit"],
              detached: process.platform !== "win32",
              shell: false,
            },
          );
          child.stdin.end(JSON.stringify(manifest));
          const timer = setTimeout(() => {
            try {
              if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {
              /* Child group is already stopped. */
            }
            reject(Error("Request checks exceeded 180 seconds."));
          }, 180000);
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on("exit", (code) => {
            clearTimeout(timer);
            try {
              if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
            } catch {
              /* Child group is already stopped. */
            }
            if (code === 0 || code === 1) done();
            else reject(Error("The request test runner stopped unexpectedly."));
          });
        });
        testResults = JSON.parse(await readFile(resultFile, "utf8"));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      if (!testResults.length)
        throw Error("The application could not start; inspect the runner logs.");
      if (testResults.some((r) => r.status !== "SUCCEEDED")) {
        await report("test", "FAILED", "A saved request test failed.", { testResults });
        await report("complete", "FAILED", "Request checks failed.");
        completed = true;
        process.exitCode = 1;
        return;
      }
    } else {
      await execute(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["test"],
        {
          cwd: root,
          env: testEnv,
        },
        "test",
      );
    }
    await report(
      "test",
      "SUCCEEDED",
      "Configured checks passed. Only the selected tests were exercised.",
      { testResults },
    );
    await report("complete", "SUCCEEDED", "Configured checks passed.");
    completed = true;
  } catch (error) {
    if (!completed && manifest.investigation) {
      const plan = manifest.investigation;
      try {
        await send("investigations/" + encodeURIComponent(plan.investigationId) + "/report", {
          requestId: plan.requestId,
          runId: id,
          commit: sha,
          status: "BLOCKED",
          command: { directory: manifest.config.directory, script: "", testPath: null },
          counts: { passed: 0, failed: 0, skipped: 0 },
          failures: [],
          message: sanitizeDiagnostic(error.message, 2000),
          durationMs: 0,
          exitCode: 1,
          truncated: false,
          nodeVersion: process.version,
        });
      } catch {
        console.warn(
          "Structured investigation evidence could not be delivered; inspect runner logs.",
        );
      }
    }
    if (!completed)
      try {
        if (currentPhase !== "complete") await report(currentPhase, "FAILED", error.message);
        await report("complete", "FAILED", error.message);
      } catch {
        console.error(
          "Traceyard could not receive the final result. Inspect the local/GitHub logs.",
        );
      }
    throw error;
  } finally {
    if (pytestSandbox) await rm(pytestSandbox, { recursive: true, force: true }).catch(() => {});
    if (relay) await relay.close();
  }
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => "")) ===
    (await realpath(fileURLToPath(import.meta.url)))
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
