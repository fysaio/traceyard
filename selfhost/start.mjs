#!/usr/bin/env node
// Starts a self-hosted Traceyard: applies database migrations to the SQLite
// files in TRACEYARD_DATA_DIR, serves the app with the local Workers runtime,
// and runs the scheduled jobs every five minutes.
import { spawn } from "node:child_process";
import { createPrivateKey, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = resolve(process.env.TRACEYARD_DATA_DIR ?? resolve(root, "data"));
const port = process.env.PORT ?? "8787";
const host = process.env.HOST ?? "0.0.0.0";
const origin = new URL(process.env.PUBLIC_APP_ORIGIN ?? `http://localhost:${port}`).origin;
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const built = resolve(root, "dist/worker/wrangler.json");
const config = resolve(root, "selfhost/wrangler.json");
const PASSED = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "TRACEYARD_RUNNER_REF",
  "SOURCE_SCAN_FILE_LIMIT",
  "SOURCE_SCAN_FILE_BYTES",
  "BUILD_REVISION",
];

const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_SEND_ERROR_REPORTS: "false",
  DO_NOT_TRACK: "1",
  CI: "true",
};
const run = (args, options = {}) =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd: root,
      env,
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? done() : reject(Error(`wrangler ${args[0]} exited with ${code}`)),
    );
    if (options.keep) options.keep(child);
  });

// Only what the self-hosted runtime supports: no Cloudflare account, no
// managed containers. The database name is kept so local SQLite files match.
const workerConfig = JSON.parse(await readFile(built, "utf8"));
const selfhosted = {
  name: workerConfig.name,
  main: "./worker.mjs",
  compatibility_date: workerConfig.compatibility_date,
  compatibility_flags: workerConfig.compatibility_flags ?? [],
  assets: {
    directory: "../dist/client",
    not_found_handling: "single-page-application",
    run_worker_first: [...(workerConfig.assets?.run_worker_first ?? []), "/__traceyard/*"],
  },
  d1_databases: workerConfig.d1_databases.map((db) => ({
    binding: db.binding,
    database_name: db.database_name,
    database_id: db.database_id,
    migrations_dir: "../migrations",
  })),
  workflows: workerConfig.workflows,
  vars: workerConfig.vars,
};
await writeFile(config, JSON.stringify(selfhosted, null, 2) + "\n");

const values = {
  PUBLIC_APP_ORIGIN: origin,
  TRACEYARD_CRON_SECRET: randomBytes(24).toString("hex"),
};
// NAME_FILE (e.g. a Docker secret) works for every value, which suits the App private key.
for (const name of PASSED) {
  const file = process.env[`${name}_FILE`];
  const value = file ? (await readFile(file, "utf8")).trim() : process.env[name];
  if (value) values[name] = value;
}
if (values.GITHUB_APP_PRIVATE_KEY)
  values.GITHUB_APP_PRIVATE_KEY = createPrivateKey(
    values.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
  )
    .export({ format: "pem", type: "pkcs8" })
    .toString();
await writeFile(
  resolve(root, "selfhost/.dev.vars"),
  Object.entries(values)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
if (!values.GITHUB_CLIENT_ID)
  console.warn(
    "[traceyard] GITHUB_CLIENT_ID is not set, so GitHub sign-in is off. See docs/SELF_HOSTING.md.",
  );

await mkdir(data, { recursive: true });
await run(["d1", "migrations", "apply", "DB", "--local", "--persist-to", data, "-c", config]);

let server;
const stop = (signal) => {
  clearInterval(timer);
  server?.kill(signal);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

const local = `http://127.0.0.1:${port}`;
const tick = async () => {
  try {
    const response = await fetch(`${local}/__traceyard/scheduled`, {
      method: "POST",
      headers: { "x-traceyard-cron": values.TRACEYARD_CRON_SECRET },
    });
    if (response.status !== 204)
      console.error(`[traceyard] scheduled jobs returned ${response.status}`);
  } catch (error) {
    console.error(`[traceyard] scheduled jobs failed: ${error.message}`);
  }
};
const timer = setInterval(tick, 5 * 60_000);
console.log(`[traceyard] serving ${origin} (data in ${data})`);
await run(
  [
    "dev",
    "-c",
    config,
    "--local",
    "--persist-to",
    data,
    "--ip",
    host,
    "--port",
    port,
    "--show-interactive-dev-session=false",
    "--log-level",
    process.env.TRACEYARD_LOG_LEVEL ?? "info",
  ],
  { keep: (child) => (server = child) },
).finally(() => clearInterval(timer));
