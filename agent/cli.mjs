#!/usr/bin/env node
import { readdir, readFile, lstat, appendFile, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { discoverFile } from "./discovery.mjs";

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
function execute(program, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, {
      ...options,
      stdio: "inherit",
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
    });
    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
      reject(new Error("Command exceeded the 180 second limit."));
    }, 180000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (process.platform !== "win32")
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* Group already stopped. */
        }
      if (code === 0) resolveRun();
      else reject(new Error(`Command failed (${signal ?? code}).`));
    });
  });
}
export async function main(args = process.argv.slice(2)) {
  const [command = "help", directory = "."] = args;
  let root = resolve(directory);
  if (command === "help" || !["scan", "connect", "run"].includes(command)) {
    console.log(
      "Traceyard: scan [directory] (offline), connect [directory] (upload source index), run [directory] (install/build/test with recording).",
    );
    return;
  }
  if (command === "scan") {
    console.log(JSON.stringify(await scanDirectory(root), null, 2));
    return;
  }
  try {
    process.loadEnvFile(join(root, ".env.traceyard"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
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
  const id = isActions
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
    : "local-" + randomUUID();
  let sha = null;
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* An uncommitted local directory is supported. */
  }
  async function credential() {
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
    return (await result.json()).value;
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
  if (!isActions) await send("repository/register", { name: basename(root) });
  let completed = false;
  const manifestResponse = await fetch(
    origin +
      "/api/v1/repository/configuration" +
      (process.env.TRACEYARD_RUN_REQUEST
        ? "?request=" + encodeURIComponent(process.env.TRACEYARD_RUN_REQUEST)
        : args.includes("--case")
          ? "?case=" +
            encodeURIComponent(args[args.indexOf("--case") + 1] ?? "") +
            "&run=" +
            encodeURIComponent(id)
          : ""),
    {
      headers: { Authorization: "Bearer " + (await credential()) },
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
  if (relative(workspaceRoot, root).startsWith("..") || !(await lstat(root)).isDirectory())
    throw Error("The configured application directory is not inside this project.");
  try {
    console.log("Traceyard: discovering source entry points…");
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
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    } catch {
      await report(
        "complete",
        "SKIPPED",
        "This runner supports npm projects. Configure a supported runtime to execute tests.",
      );
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
    const env = { ...process.env };
    delete env.TRACEYARD_KEY;
    delete env.NODE_OPTIONS;
    await report("install", "RUNNING", "Installing project dependencies.");
    let locked = true;
    try {
      await lstat(join(root, "package-lock.json"));
    } catch {
      locked = false;
    }
    if (!locked) {
      await report(
        "complete",
        "SKIPPED",
        "A package-lock.json is required for reproducible npm installs.",
      );
      completed = true;
      return;
    }
    await execute(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], { cwd: root, env });
    await report("install", "SUCCEEDED", "Dependencies installed.");
    if (pkg.scripts?.build) {
      await report("build", "RUNNING", "Running the existing build script.");
      await execute(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
        cwd: root,
        env,
      });
      await report("build", "SUCCEEDED", "Build completed.");
    } else await report("build", "SKIPPED", "No build script configured.");
    if (
      !manifest.cases.length &&
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
      "Running the existing test script with supported Node.js tracing.",
    );
    const preload = fileURLToPath(new URL("./register.cjs", import.meta.url));
    const key = await credential();
    const testEnv = {
      ...env,
      CI: "true",
      TRACEYARD_RUN_ID: id,
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      OTEL_SERVICE_NAME: basename(root),
      OTEL_RESOURCE_ATTRIBUTES: `traceyard.run.id=${id}`,
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_TRACES_SAMPLER: "always_on",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: origin + "/api/v1/otlp/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20" + encodeURIComponent(key),
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "32",
      OTEL_BSP_SCHEDULE_DELAY: "200",
      OTEL_NODE_RESOURCE_DETECTORS: "env,process",
      OTEL_EXPORTER_OTLP_TIMEOUT: "3000",
    };
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
      await execute(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], {
        cwd: root,
        env: testEnv,
      });
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
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
