import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readUntrustedFile, sandboxed, sandboxIdentity } from "../../agent/sandbox.mjs";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "traceyard-sandbox-"));
  cleanups.push(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {}),
  );
  return root;
};

describe("sandbox identity", () => {
  it("is off when no sandbox user is configured", async () => {
    await expect(sandboxIdentity({})).resolves.toBeNull();
    await expect(sandboxIdentity({ TRACEYARD_SANDBOX_USER: "" })).resolves.toBeNull();
  });

  it.each(["node", "1000", "1000:", "-1:1000", "1000:1000:1", "1e3:1000"])(
    "rejects the malformed identity %j",
    async (value) => {
      await expect(sandboxIdentity({ TRACEYARD_SANDBOX_USER: value })).rejects.toThrow(/uid:gid/);
    },
  );

  it.each(["0:1000", "1000:0"])("refuses to run repository code as root (%s)", async (value) => {
    await expect(sandboxIdentity({ TRACEYARD_SANDBOX_USER: value })).rejects.toThrow(/root/);
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails closed when the agent cannot switch users",
    async () => {
      await expect(sandboxIdentity({ TRACEYARD_SANDBOX_USER: "1000:1000" })).rejects.toThrow(
        /must start as root/,
      );
    },
  );

  it("adds the identity and home directory to child options", () => {
    const options = { cwd: "/w", env: { PATH: "/bin", HOME: "/root" } };
    expect(sandboxed(null, options)).toBe(options);
    expect(sandboxed({ uid: 1000, gid: 1000, home: "/home/node" }, options)).toEqual({
      cwd: "/w",
      uid: 1000,
      gid: 1000,
      env: { PATH: "/bin", HOME: "/home/node" },
    });
  });
});

describe("untrusted output files", () => {
  it("reads a regular file", async () => {
    const root = await temporary();
    await writeFile(join(root, "results.json"), "[]");
    await expect(readUntrustedFile(join(root, "results.json"))).resolves.toBe("[]");
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a link planted in place of the file",
    async () => {
      const root = await temporary();
      await writeFile(join(root, "secret"), "agent-only");
      await symlink(join(root, "secret"), join(root, "results.json"));
      await expect(readUntrustedFile(join(root, "results.json"))).rejects.toMatchObject({
        code: "ELOOP",
      });
    },
  );
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "agent with a required sandbox",
  { timeout: 60000 },
  () => {
    it("refuses to run any repository command when it cannot drop privileges", async () => {
      const root = await temporary();
      const marker = join(root, "ran");
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "sandbox-fixture",
          version: "1.0.0",
          scripts: { test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'')"` },
        }),
      );
      await writeFile(
        join(root, "package-lock.json"),
        JSON.stringify({
          name: "sandbox-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: { "": { name: "sandbox-fixture", version: "1.0.0" } },
        }),
      );
      const reports: { phase: string; status: string; message: string }[] = [];
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        res.setHeader("content-type", "application/json");
        if (req.method === "GET")
          return res.end(
            JSON.stringify({ data: { config: { directory: ".", port: 3000 }, cases: [] } }),
          );
        if (req.url === "/api/v1/repository-runs") reports.push(JSON.parse(body));
        res.end(JSON.stringify({ data: { received: true } }));
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      cleanups.push(
        () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw Error("No collector");
      const code = await new Promise<number | null>((done, reject) => {
        const child = spawn(process.execPath, [resolve("agent/cli.mjs"), "run", root], {
          env: {
            ...process.env,
            GITHUB_ACTIONS: "false",
            TRACEYARD_ORIGIN: "http://127.0.0.1:" + address.port,
            TRACEYARD_RUN_TOKEN: "tyr_" + "A".repeat(43),
            TRACEYARD_MANAGED_RUN_ID: "managed_" + "a".repeat(32),
            TRACEYARD_COMMIT_SHA: "a".repeat(40),
            TRACEYARD_SANDBOX_USER: "1000:1000",
          },
          stdio: "ignore",
        });
        child.on("error", reject);
        child.on("exit", done);
      });
      expect(code).toBe(1);
      expect(reports.at(-1)).toMatchObject({ phase: "complete", status: "FAILED" });
      expect(reports.at(-1)?.message).toMatch(/must start as root/);
      expect(reports.some((r) => r.phase === "install")).toBe(false);
      await expect(readUntrustedFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
