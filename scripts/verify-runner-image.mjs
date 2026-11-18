import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// CI mounts only this test script into the built image. The collector and the
// disposable application both run inside that image, with no external network.
// --agent supports checking the harness locally; it is not image acceptance.
const local = process.argv.includes("--agent");
const agent = local
  ? resolve(process.argv[process.argv.indexOf("--agent") + 1] ?? "")
  : "/opt/traceyard/agent/cli.mjs";
await access(agent);
if (!local) {
  assert.match(process.version, /^v22\./, "The runner must ship Node.js 22.");
  assert.equal(process.getuid(), 1000, "Application commands must run as the node user.");
  assert.match(execFileSync("git", ["--version"], { encoding: "utf8" }), /^git version /);
  // Only production dependencies and the agent should be baked into the image.
  await assert.rejects(access("/opt/traceyard/.dev.vars"));
  await assert.rejects(access("/opt/traceyard/worker"));
  await assert.rejects(access("/opt/traceyard/node_modules/@modelcontextprotocol/sdk"));
  await assert.rejects(access("/opt/traceyard/node_modules/react"));
}

for (const mode of ["success", "test-failure", "install-failure"]) {
  const root = await mkdtemp(join(tmpdir(), "traceyard-image-"));
  const id =
    "managed_" + (mode === "success" ? "a" : mode === "test-failure" ? "b" : "c").repeat(32);
  const token = "tyr_" + "A".repeat(43);
  const sha = "a".repeat(40);
  const reports = [],
    exports = [],
    failures = [];
  const collector = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer " + token);
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/api/v1/repository/configuration") {
        response.end(
          JSON.stringify({
            data: { config: { directory: ".", startScript: "", port: 3000 }, cases: [] },
          }),
        );
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (request.url === "/api/v1/repository-runs") {
        assert.equal(body.id, id);
        assert.equal(body.sha, sha);
        reports.push(body);
      } else if (request.url === "/api/v1/otlp/v1/traces") {
        exports.push(body);
      } else throw Error("Unexpected runner request: " + request.url);
      response.end(JSON.stringify({ data: { received: true } }));
    } catch (error) {
      failures.push(error);
      response
        .writeHead(500)
        .end(JSON.stringify({ error: { message: "Fixture rejected request" } }));
    }
  });
  await new Promise((done) => collector.listen(0, "127.0.0.1", done));
  try {
    const pkg = {
      name: "runner-image-fixture",
      version: "1.0.0",
      type: "module",
      scripts: {
        build: 'node -e "process.exit(0)"',
        test: "node --test test.mjs",
        ...(mode === "install-failure" ? { install: 'node -e "process.exit(1)"' } : {}),
      },
    };
    await writeFile(join(root, "package.json"), JSON.stringify(pkg));
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: pkg.name,
            version: pkg.version,
            ...(mode === "install-failure" ? { hasInstallScript: true } : {}),
          },
        },
      }),
    );
    await writeFile(join(root, "server.ts"), "app.get('/health', () => healthy());");
    await writeFile(
      join(root, "test.mjs"),
      `
      import { test } from 'node:test';
      import { createServer } from 'node:http';
      import { once } from 'node:events';
      test('real application HTTP request', async () => {
        if (process.env.TRACEYARD_RUN_TOKEN) throw Error('Control token leaked to application environment');
        const server = createServer((req, res) => res.end('ok'));
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        try {
          const response = await fetch('http://127.0.0.1:' + server.address().port + '/health');
          if (await response.text() !== 'ok') throw Error('Unexpected health response');
        } finally { server.closeAllConnections(); server.close(); }
        ${mode === "test-failure" ? "throw Error('Deliberate image smoke test failure');" : ""}
      });
    `,
    );
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [agent, "run", root], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME ?? tmpdir(),
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
          TRACEYARD_ORIGIN: "http://127.0.0.1:" + collector.address().port,
          TRACEYARD_MANAGED_RUN_ID: id,
          TRACEYARD_COMMIT_SHA: sha,
          TRACEYARD_RUN_TOKEN: token,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (bytes) => {
        output = (output + bytes).slice(-16000);
      });
      child.stderr.on("data", (bytes) => {
        output = (output + bytes).slice(-16000);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("Image check exceeded 90 seconds"));
      }, 90000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        done({ code, output });
      });
    });
    assert.equal(failures.length, 0, String(failures[0] ?? ""));
    assert.equal(result.code, mode === "success" ? 0 : 1, result.output);
    assert.ok(!result.output.includes(token), "Control credential appeared in command output.");
    assert.equal(reports.at(-1)?.phase, "complete", result.output);
    assert.equal(
      reports.at(-1)?.status,
      mode === "success" ? "SUCCEEDED" : "FAILED",
      result.output,
    );
    assert.ok(
      reports.some((report) =>
        report.operations?.some((operation) => operation.name === "GET /health"),
      ),
      "Source discovery must survive failed commands.",
    );
    if (mode === "install-failure") {
      assert.ok(reports.some((report) => report.phase === "install" && report.status === "FAILED"));
      assert.ok(!reports.some((report) => report.phase === "test"));
    } else {
      assert.ok(
        reports.some((report) => report.phase === "build" && report.status === "SUCCEEDED"),
      );
      const spans = exports
        .flatMap((batch) => batch.resourceSpans ?? [])
        .flatMap((resource) => resource.scopeSpans ?? [])
        .flatMap((scope) => scope.spans ?? []);
      assert.ok(
        spans.some(
          (span) =>
            span.kind === 2 &&
            span.attributes?.some((attribute) =>
              ["http.method", "http.request.method"].includes(attribute.key),
            ),
        ),
        "No actual server HTTP span was exported by the packaged recorder.",
      );
    }
    assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).name, pkg.name);
    console.log(`${local ? "Harness" : "Runner image"}: ${mode} passed.`);
  } finally {
    collector.closeAllConnections();
    await new Promise((done) => collector.close(done));
    await rm(root, { recursive: true, force: true });
  }
}
