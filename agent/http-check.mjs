// Runs only inside the user's local/GitHub test runner. Requests never target a remote host.
import { TextDecoder } from "node:util";
import { spawn, execSync } from "node:child_process";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const { config, cases } = JSON.parse(raw);
const output = process.env.TRACEYARD_RESULTS_FILE;
if (!output || !/^[A-Za-z0-9:_-]+$/.test(config.startScript ?? ""))
  throw Error("Configure a valid startup script before running request tests.");
const results = [];
const ready = () =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: config.port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(250, () => {
      socket.destroy();
      resolve(false);
    });
  });
if (await ready())
  throw Error("The configured test port is already in use. Choose an unused port.");
const server = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", config.startScript],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.TRACEYARD_PRELOAD ?? process.env.NODE_OPTIONS,
      PORT: String(config.port),
      TRACEYARD_FLUSH_ON_TERM: "true",
    },
    stdio: ["ignore", "inherit", "inherit"],
    shell: process.platform === "win32",
  },
);
let stopped = false;
server.on("error", () => {
  stopped = true;
});
server.on("exit", () => {
  stopped = true;
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function safePreview(value) {
  const clean = (v, depth = 0) => {
    if (depth > 6) return "[truncated]";
    if (typeof v === "string")
      return v
        .replace(/Bearer\s+[^\s"']+|tyk_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{10,}/gi, "[redacted]")
        .slice(0, 2000);
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => clean(x, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .slice(0, 30)
          .map(([k, x]) => [
            k,
            /(?:password|secret|token|authorization|api.?key|cookie)/i.test(k)
              ? "[redacted]"
              : clean(x, depth + 1),
          ]),
      );
    return v;
  };
  return JSON.stringify(clean(value), null, 2).slice(0, 2400);
}
async function emit(test, start, end, traceId, spanId, failed) {
  const headers = process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "";
  const auth = headers
    .split(",")
    .find((v) => v.startsWith("Authorization="))
    ?.slice(14);
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!endpoint || !auth) throw Error("Trace recording is not configured.");
  const attrs = {
    "traceyard.operation.key": test.operationKey,
    "traceyard.test.case": test.id,
    "traceyard.run.id": process.env.TRACEYARD_RUN_ID,
    "http.route": test.path.split("?")[0],
    "http.request.method": test.method,
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: decodeURIComponent(auth) },
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "Request tests" } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  spanId,
                  name: test.name,
                  startTimeUnixNano: String(BigInt(start) * 1000000n),
                  endTimeUnixNano: String(BigInt(end) * 1000000n),
                  status: { code: failed ? 2 : 1 },
                  attributes: Object.entries(attrs)
                    .filter(([, v]) => typeof v === "string")
                    .map(([key, v]) => ({ key, value: { stringValue: v } })),
                },
              ],
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error("Traceyard could not record the request test.");
}
let interrupted = false;
process.once("SIGTERM", () => {
  interrupted = true;
  server.kill("SIGTERM");
});
try {
  const deadline = Date.now() + 30000;
  let listening = false;
  while (Date.now() < deadline && !stopped && !interrupted) {
    if (await ready()) {
      listening = true;
      break;
    }
    await pause(150);
  }
  if (!listening)
    throw Error(
      stopped
        ? "The application stopped before accepting connections. Check the startup script and test environment."
        : "The application did not listen on the configured port within 30 seconds.",
    );
  for (const test of cases) {
    const start = Date.now(),
      traceId = randomBytes(16).toString("hex"),
      spanId = randomBytes(8).toString("hex");
    const result = {
      caseId: test.id,
      name: test.name,
      operationKey: test.operationKey,
      traceId,
      status: "FAILED",
      durationMs: 0,
      responseStatus: null,
      checks: [],
    };
    try {
      if (interrupted) throw Error("Test cancelled.");
      const origin = `http://127.0.0.1:${config.port}`,
        url = new URL(test.path, origin);
      if (url.origin !== origin) throw Error("Request tests must target the local application.");
      const response = await fetch(url, {
        method: test.method,
        redirect: "manual",
        headers: { "Content-Type": "application/json", traceparent: `00-${traceId}-${spanId}-01` },
        ...(!["GET", "HEAD"].includes(test.method) && test.body !== undefined
          ? { body: JSON.stringify(test.body) }
          : {}),
        signal: AbortSignal.timeout(15000),
      });
      result.responseStatus = response.status;
      result.checks.push({
        name: `HTTP status is ${test.expectedStatus}`,
        passed: response.status === test.expectedStatus,
      });
      // Bound response reads before parsing or storing; redirects are never followed.
      const reader = response.body?.getReader();
      let text = "",
        length = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 32768) {
            await reader.cancel();
            throw Error("Response exceeds the 32 KB test limit.");
          }
          text += new TextDecoder().decode(value, { stream: true });
        }
      }
      let value = text;
      try {
        value = JSON.parse(text);
      } catch {
        /* Plain text responses are valid. */
      }
      if (test.responsePath) {
        let actual = value;
        for (const part of test.responsePath.split("."))
          actual =
            actual != null &&
            typeof actual === "object" &&
            !["__proto__", "constructor", "prototype"].includes(part)
              ? actual[part]
              : undefined;
        result.checks.push({
          name: `Response ${test.responsePath} matches`,
          passed: JSON.stringify(actual) === JSON.stringify(test.expectedValue),
        });
      }
      if (test.captureResponse) result.responsePreview = safePreview(value);
      result.status = result.checks.every((c) => c.passed) ? "SUCCEEDED" : "FAILED";
    } catch (error) {
      result.error = String(error.message).slice(0, 500);
    }
    result.durationMs = Date.now() - start;
    await emit(test, start, Date.now(), traceId, spanId, result.status === "FAILED");
    results.push(result);
  }
} finally {
  await pause(600);
  if (process.platform !== "win32") {
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {
      /* Group already stopped. */
    }
  } else {
    try {
      execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
    } catch {
      try {
        server.kill("SIGTERM");
      } catch {
        /* Already stopped. */
      }
    }
  }
  const stopDeadline = Date.now() + 4000;
  while (Date.now() < stopDeadline && (await ready())) await pause(50);
  await writeFile(output, JSON.stringify(results), { mode: 0o600 });
}
if (results.some((r) => r.status === "FAILED")) process.exitCode = 1;
