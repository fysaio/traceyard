import { appendFileSync, readFileSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { interactionSignature, recordingUrl, sensitive } from "./interaction-format.mjs";
const capture = process.env.TRACEYARD_CAPTURE_FILE,
  replay = process.env.TRACEYARD_REPLAY_FILE,
  state = process.env.TRACEYARD_REPLAY_STATE;
const manifest = replay ? JSON.parse(readFileSync(replay, "utf8")) : null,
  used = new Map();
const exhausted = new Set();
const write = (file, value) => {
  try {
    if (!file || exhausted.has(file)) return;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      /* First event. */
    }
    if (size > 240000) {
      exhausted.add(file);
      value =
        file === state
          ? { kind: "divergence", reason: "Replay event budget exceeded." }
          : { kind: "omission", reason: "Capture exceeded its artifact budget." };
    }
    if (file) appendFileSync(file, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    /* Recording must not alter the application result. */
  }
};
function environment() {
  return Object.entries(process.env)
    .filter(
      ([key, value]) =>
        value &&
        /^[A-Z][A-Z0-9_]{1,79}$/.test(key) &&
        !/^(?:TRACEYARD|GITHUB|ACTIONS|OTEL)_/.test(key) &&
        /API_?KEY|TOKEN|SECRET|PASSWORD|(?:DATABASE|SUPABASE|REDIS)_URL/.test(key),
    )
    .slice(0, 30)
    .map(([name, value]) => {
      try {
        if (!name.endsWith("_URL")) return { name, kind: "credential" };
        return { name, kind: "url", protocol: new URL(value).protocol };
      } catch {
        return { name, kind: "credential" };
      }
    });
}
function diverged(reason) {
  write(state, { kind: "divergence", reason });
  throw Error("Traceyard replay diverged: " + reason);
}
if (replay) {
  const denied = () => diverged("An unrecorded network interface was requested.");
  http.request = denied;
  http.get = denied;
  https.request = denied;
  https.get = denied;
  net.connect = denied;
  net.createConnection = denied;
  tls.connect = denied;
  syncBuiltinESMExports();
}
if (capture || replay) {
  const native = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const request = new globalThis.Request(input, init),
      url = recordingUrl(request.url);
    if (
      !replay &&
      process.env.TRACEYARD_RECORDING_EXCLUDE_ORIGIN &&
      new URL(request.url).origin === process.env.TRACEYARD_RECORDING_EXCLUDE_ORIGIN
    )
      return native(request);
    let raw = "",
      requestBytes = 0;
    const reader = request.clone().body?.getReader();
    if (reader) {
      const decoder = new globalThis.TextDecoder();
      while (true) {
        const part = await reader.read();
        if (part.done) {
          raw += decoder.decode();
          break;
        }
        requestBytes += part.value.length;
        if (requestBytes > 8000) {
          void reader.cancel().catch(() => {});
          break;
        }
        raw += decoder.decode(part.value, { stream: true });
      }
    }
    if (requestBytes > 8000) {
      if (replay) return diverged("The request exceeds the JSON replay budget.");
      write(capture, { kind: "omission", reason: "An oversized request was not retained." });
      return native(request);
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      if (replay) return diverged("The request body is outside JSON replay support.");
      write(capture, { kind: "omission", reason: "A non-JSON request body was not retained." });
      return native(request);
    }
    if (raw.length > 8000 || sensitive(body)) {
      if (replay) return diverged("The request is oversized or credential-bearing.");
      write(capture, {
        kind: "omission",
        reason: "An oversized or credential-bearing request was not retained.",
      });
      return native(request);
    }
    const signature = await interactionSignature(request.method, url, body);
    if (replay) {
      const matches = manifest.interactions.filter((item) => item.signature === signature),
        count = used.get(signature) ?? 0;
      if (!matches[count])
        return diverged("The code requested an unmatched or repeated interaction.");
      used.set(signature, count + 1);
      write(state, { kind: "reused", signature });
      return new globalThis.Response(JSON.stringify(matches[count].response.body), {
        status: matches[count].response.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    let response;
    try {
      response = await native(request);
    } catch (error) {
      write(capture, {
        kind: "omission",
        reason: "A fetch failed before a complete response was recorded.",
      });
      throw error;
    }
    try {
      if (!/application\/(?:[a-z.+-]*\+)?json/i.test(response.headers.get("content-type") ?? "")) {
        write(capture, {
          kind: "omission",
          reason: "A response was not JSON; streaming/text replay is unsupported.",
        });
        return response;
      }
      const reader = response.clone().body?.getReader();
      let bytes = 0,
        parts = [];
      if (reader)
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 8000) {
            void reader.cancel().catch(() => {});
            break;
          }
          parts.push(part.value);
        }
      if (bytes > 8000) {
        write(capture, {
          kind: "omission",
          reason: "An oversized JSON response was not retained.",
        });
        return response;
      }
      const merged = new Uint8Array(bytes);
      let offset = 0;
      for (const part of parts) {
        merged.set(part, offset);
        offset += part.length;
      }
      const value = JSON.parse(new globalThis.TextDecoder().decode(merged));
      if (sensitive(value)) {
        write(capture, {
          kind: "omission",
          reason: "A credential-bearing response was not retained.",
        });
        return response;
      }
      write(capture, {
        kind: "interaction",
        item: {
          signature,
          method: request.method,
          url,
          requestBody: body,
          response: { status: response.status, body: value },
        },
        environment: environment(),
      });
    } catch {
      write(capture, {
        kind: "omission",
        reason: "A response could not be retained as complete JSON.",
      });
    }
    return response;
  };
}
