// Operator release command. Uses the existing Cloudflare login and server secrets.
import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url)),
  args = process.argv.slice(2);
if (!args.includes("--origin")) throw Error("Use --origin https://YOUR_TRACEYARD_HOST");
const origin = new URL(args[args.indexOf("--origin") + 1] ?? "");
if (
  !args.includes("--origin") ||
  origin.protocol !== "https:" ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  origin.username ||
  origin.password
)
  throw Error("Use --origin https://YOUR_TRACEYARD_HOST");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
if (
  git("branch", "--show-current") !== "main" ||
  git("status", "--porcelain", "--untracked-files=no")
)
  throw Error("Deploy a clean main checkout after its CI gates pass.");
const revision = git("rev-parse", "HEAD");
const runner = (await readFile(resolve(root, "shared/repository/runner-version.ts"), "utf8")).match(
  /REVIEWED_RUNNER_REVISION = "([a-f0-9]{40})"/,
)?.[1];
if (!runner) throw Error("The reviewed runner revision is missing.");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const execute = (command, parameters, input) =>
  new Promise((done, reject) => {
    const child = spawn(command, parameters, {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_SEND_ERROR_REPORTS: "false" },
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
      shell: process.platform === "win32" && command.endsWith(".cmd"),
    });
    if (input !== undefined) child.stdin.end(input);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? done() : reject(Error("Release command failed with exit " + code)),
    );
  });
const cf = (...a) => execute(process.execPath, [wrangler, ...a]);
await execute(process.platform === "win32" ? "npm.cmd" : "npm", ["test"]);
await execute(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);
await cf(
  "d1",
  "migrations",
  "apply",
  "traceyard-prod-db",
  "--remote",
  "--config",
  "wrangler.jsonc",
);
await execute(
  process.execPath,
  [wrangler, "secret", "put", "TRACEYARD_RUNNER_REF", "--config", "wrangler.jsonc"],
  runner + "\n",
);
await cf("deploy", "--config", "dist/worker/wrangler.json", "--var", "BUILD_REVISION:" + revision);
const health = await fetch(origin.origin + "/api/health").then((r) => r.json());
if (health.data?.status !== "ok" || health.data?.revision !== revision)
  throw Error("The public health endpoint does not establish the deployed source revision.");
const metadata = await fetch(origin.origin + "/.well-known/oauth-protected-resource/mcp").then(
  (r) => r.json(),
);
if (metadata.resource !== origin.origin + "/mcp")
  throw Error("The public MCP resource metadata is not configured for this origin.");
const challenge = await fetch(origin.origin + "/mcp", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
if (challenge.status !== 401 || !challenge.headers.get("www-authenticate"))
  throw Error("The MCP endpoint did not return its authorization challenge.");
console.log(
  "Deployed source " +
    revision +
    " with reviewed runner " +
    runner +
    ". Public health and MCP discovery passed. Complete one browser authorization and focused repository test before declaring live acceptance.",
);
