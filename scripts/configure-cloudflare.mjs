#!/usr/bin/env node
// One-time operator setup. Credentials stay on this computer and travel to Cloudflare via stdin.
import { loadEnvFile } from "node:process";
import { createPrivateKey } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name) {
  return args[args.indexOf(name) + 1];
}
const originValue = args.includes("--origin") ? option("--origin") : null;
if (!originValue) {
  console.error(
    "Usage: npm run configure:cloudflare -- --origin https://YOUR_WORKER.workers.dev [--file .dev.vars] [--account ACCOUNT_ID]",
  );
  process.exit(1);
}
const origin = new URL(originValue);
if (
  origin.protocol !== "https:" ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  origin.username ||
  origin.password
)
  throw Error("Use the public HTTPS origin of your Traceyard Worker.");
loadEnvFile(resolve(root, args.includes("--file") ? option("--file") : ".dev.vars"));
const required = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error("Missing configuration names: " + missing.join(", "));
  process.exit(1);
}
const values = Object.fromEntries(required.map((name) => [name, process.env[name]]));
try {
  values.GITHUB_APP_PRIVATE_KEY = createPrivateKey(
    values.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
  )
    .export({ type: "pkcs8", format: "pem" })
    .toString();
} catch {
  throw Error("GITHUB_APP_PRIVATE_KEY must contain the downloaded RSA private key.");
}
values.PUBLIC_APP_ORIGIN = origin.origin;
const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_SEND_ERROR_REPORTS: "false",
  DO_NOT_TRACK: "1",
};
if (args.includes("--account")) env.CLOUDFLARE_ACCOUNT_ID = option("--account");
// Do not pass GitHub credentials through inherited environment variables.
for (const name of [...required, "PUBLIC_APP_ORIGIN"]) delete env[name];
function wrangler(command, input) {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve(root, "node_modules/wrangler/bin/wrangler.js"),
        ...command,
        "--config",
        resolve(root, "wrangler.jsonc"),
      ],
      { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    // Wrangler errors may contain request details; never echo captured output.
    child.stderr.resume();
    child.on("error", () => reject(Error("Wrangler could not start. Run npm ci first.")));
    child.on("close", (code) =>
      code === 0
        ? done(output)
        : reject(
            Error(
              "Cloudflare setup failed. Check Wrangler login and your account access; no credentials were printed.",
            ),
          ),
    );
    child.stdin.end(input);
  });
}
await wrangler(["secret", "bulk"], JSON.stringify(values));
console.log("Traceyard configuration uploaded. Credential values were not printed.");
console.log("GitHub OAuth callback: " + origin.origin + "/api/auth/github/callback");
console.log("GitHub App webhook: " + origin.origin + "/api/github/webhook");
