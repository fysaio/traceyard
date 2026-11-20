import { it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
it("uploads only operator configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "traceyard-setup-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "node_modules/wrangler/bin"), { recursive: true });
    await copyFile(
      resolve("scripts/configure-cloudflare.mjs"),
      join(root, "scripts/configure-cloudflare.mjs"),
    );
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();
    await writeFile(
      join(root, ".dev.vars"),
      [
        "GITHUB_CLIENT_ID=test-client",
        "GITHUB_CLIENT_SECRET=client-secret-sentinel",
        "GITHUB_APP_ID=123",
        "GITHUB_APP_SLUG=test-app",
        "GITHUB_APP_WEBHOOK_SECRET=webhook-sentinel",
        `GITHUB_APP_PRIVATE_KEY="${privateKey.replace(/\n/g, "\\n")}"`,
        "UNRELATED_SECRET=must-not-upload",
      ].join("\n"),
    );
    await writeFile(
      join(root, "node_modules/wrangler/bin/wrangler.js"),
      `
      const fs = require('node:fs');
      if (process.argv.includes('list')) {
        process.stdout.write("[]");
      } else {
        let data = '';
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => fs.writeFileSync('captured.json', JSON.stringify({
          data: JSON.parse(data), args: process.argv,
          inherited: process.env.GITHUB_APP_PRIVATE_KEY,
          telemetry: process.env.WRANGLER_SEND_METRICS,
        })));
      }
    `,
    );
    const env = { ...process.env };
    for (const name of Object.keys(env))
      if (/^(?:GITHUB_|CLOUDFLARE_|PUBLIC_APP_ORIGIN)/.test(name)) delete env[name];
    const result = await exec(
      process.execPath,
      [
        join(root, "scripts/configure-cloudflare.mjs"),
        "--origin",
        "https://traceyard.example",
        "--account",
        "test-account",
      ],
      { env },
    );
    const upload = JSON.parse(await readFile(join(root, "captured.json"), "utf8"));
    expect(upload.data.GITHUB_CLIENT_SECRET).toBe("client-secret-sentinel");
    expect(upload.data.PUBLIC_APP_ORIGIN).toBe("https://traceyard.example");
    expect(upload.data.GITHUB_APP_PRIVATE_KEY).toContain("BEGIN PRIVATE KEY");
    expect(upload.data.UNRELATED_SECRET).toBeUndefined();
    expect(upload.inherited).toBeUndefined();
    expect(upload.telemetry).toBe("false");
    expect(upload.args.join(" ")).not.toContain("client-secret-sentinel");
    expect(result.stdout + result.stderr).not.toMatch(
      /client-secret-sentinel|webhook-sentinel|BEGIN PRIVATE KEY/,
    );
    expect(Object.keys(upload.data)).not.toContain("INTEGRATION_ENCRYPTION_KEY");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
