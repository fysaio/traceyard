// Trusted loopback relay for OpenTelemetry trace exports.
//
// Repository tests and applications are untrusted code. They must be able to
// export spans, but must never hold the Traceyard reporting credential, which
// can also post run and investigation reports. The relay runs inside the
// trusted agent process, accepts only OTLP/JSON trace batches on loopback, and
// forwards them to the one trace endpoint with the credential attached.
import { createServer } from "node:http";

export const RELAY_MAX_BODY_BYTES = 32 * 1024;
const RELAY_PATH = "/v1/traces";

/**
 * @param {{ target: string, credential: () => Promise<string>, fetch?: typeof fetch }} options
 * @returns {Promise<{ endpoint: string, origin: string, close: () => Promise<void> }>}
 */
export async function startTelemetryRelay({ target, credential, fetch: send = fetch }) {
  const destination = new URL(target);
  if (destination.username || destination.password || destination.search || destination.hash)
    throw Error("The trace relay target must be a plain URL.");
  const server = createServer(async (request, response) => {
    const reply = (status, message) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(message ? { error: { message } } : {}));
    };
    try {
      if (request.method !== "POST" || request.url !== RELAY_PATH) {
        request.resume();
        return reply(404, "Only OTLP trace exports are relayed.");
      }
      if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        request.resume();
        return reply(415, "Trace exports must use OTLP/JSON.");
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > RELAY_MAX_BODY_BYTES) {
          request.resume();
          return reply(413, "Trace export exceeds the 32 KB limit.");
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        JSON.parse(body);
      } catch {
        return reply(400, "Trace export is not valid JSON.");
      }
      // Headers from the untrusted caller are never forwarded.
      const upstream = await send(destination, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + (await credential()),
          "Content-Type": "application/json",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      await upstream.arrayBuffer().catch(() => {});
      reply(upstream.ok ? 200 : 502, upstream.ok ? undefined : "Traceyard rejected the traces.");
    } catch {
      if (!response.headersSent) reply(502, "Traces could not be forwarded.");
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("The trace relay did not start.");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    endpoint: origin + RELAY_PATH,
    origin,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Credentials and control-plane values that untrusted repository code must
// never inherit. Values are matched by exact name or by prefix.
const SECRET_NAMES = new Set([
  "TRACEYARD_KEY",
  "TRACEYARD_RUN_TOKEN",
  "TRACEYARD_GITHUB_FETCH_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
  "ACTIONS_RESULTS_URL",
  "ACTIONS_CACHE_URL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "NODE_OPTIONS",
]);

/** Returns a copy of `env` without credentials or control-plane values. */
export function untrustedEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => value !== undefined && !SECRET_NAMES.has(name.toUpperCase()),
    ),
  );
}

// Keys a local `.env.traceyard` may set. The file lives in the repository, so
// hosted runs never read it, and local runs accept only connection settings.
export const LOCAL_ENV_FILE_KEYS = ["TRACEYARD_ORIGIN", "TRACEYARD_KEY"];
