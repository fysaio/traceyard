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
const revision = git("rev-parse", "HEAD");
const validated = args.includes("--validated-revision")
  ? args[args.indexOf("--validated-revision") + 1]
  : null;
if (
  validated &&
  (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_run" ||
    validated !== revision)
)
  throw Error(
    "A validated revision must match this checkout in a completed GitHub CI release workflow.",
  );
if (
  (!validated && git("branch", "--show-current") !== "main") ||
  git("status", "--porcelain", "--untracked-files=no")
)
  throw Error("Deploy a clean main checkout after its CI gates pass.");
if (validated) {
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/git/ref/heads/main`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) throw Error("Could not confirm the current main revision before deployment.");
  if ((await response.json()).object?.sha !== revision)
    throw Error(
      "A newer main revision exists. Release its completed checks instead of deploying stale code.",
    );
}
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
if (!validated) await execute(process.platform === "win32" ? "npm.cmd" : "npm", ["test"]);
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
// A new Worker version can take a few seconds to reach every edge location.
let health = null;
for (let attempt = 0; attempt < 18; attempt++) {
  health = await fetch(origin.origin + "/api/health", { cache: "no-store" })
    .then((r) => r.json())
    .catch(() => null);
  if (health?.data?.status === "ok" && health.data.revision === revision) break;
  await new Promise((done) => setTimeout(done, 5000));
}
if (health?.data?.status !== "ok" || health?.data?.revision !== revision)
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
