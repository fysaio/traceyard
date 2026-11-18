import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  interactionSignature,
  eligibleRecording,
  sensitive,
} from "../../agent/interaction-format.mjs";
import { buildRecording } from "../../agent/recording.mjs";

it("fingerprints JSON structurally and rejects incomplete or ambiguous recordings", async () => {
  expect(await interactionSignature("POST", "https://api.example/a", { b: 2, a: 1 })).toBe(
    await interactionSignature("POST", "https://api.example/a", { a: 1, b: 2 }),
  );
  expect(sensitive({ max_tokens: 100, messages: [{ content: "hello" }] })).toBe(false);
  expect(sensitive({ access_token: "credential" })).toBe(true);
  const item = {
    signature: "a".repeat(64),
    method: "GET",
    url: "https://api.example",
    requestBody: null,
    response: { status: 200, body: { value: 1 } },
  };
  const base = {
    schemaVersion: 1 as const,
    kind: "json-fetch" as const,
    sourceCommit: "a".repeat(40),
    testPath: "a.test.ts",
    environment: [],
    omissions: [],
    eligible: true,
    interactions: [item],
  };
  expect(eligibleRecording(base)).toBe(true);
  expect(eligibleRecording({ ...base, omissions: ["stream omitted"] })).toBe(false);
  expect(
    eligibleRecording({
      ...base,
      interactions: [item, { ...item, response: { status: 200, body: { value: 2 } } }],
    }),
  ).toBe(false);
});

it("captures a real JSON response without headers or credentials and blocks changed replay requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "traceyard-capture-test-")),
    capture = join(dir, "capture.jsonl"),
    manifest = join(dir, "recording.json"),
    state = join(dir, "state.jsonl");
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ value: 42 }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No test port");
  const url = `http://127.0.0.1:${address.port}/value`;
  const execute = (source: string, env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          new URL("../../agent/record-fetch.mjs", import.meta.url).pathname,
          "--input-type=module",
          "-e",
          source,
        ],
        { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => done({ code, out }));
    });
  try {
    const source = `console.log(await (await fetch(${JSON.stringify(url)}, {headers:{Authorization:'Bearer private-placeholder'}})).json())`;
    expect(
      (
        await execute(source, {
          TRACEYARD_CAPTURE_FILE: capture,
          EXAMPLE_API_KEY: "do-not-retain-this-value",
        })
      ).code,
    ).toBe(0);
    const recording = await buildRecording(capture, "a".repeat(40), "value.test.ts");
    expect(recording.eligible).toBe(true);
    expect(recording.interactions).toHaveLength(1);
    expect(JSON.stringify(recording)).not.toMatch(
      /private-placeholder|do-not-retain-this-value|Authorization/,
    );
    expect(recording.environment).toContainEqual({ name: "EXAMPLE_API_KEY", kind: "credential" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(manifest, JSON.stringify(recording));
    expect(
      (await execute(source, { TRACEYARD_REPLAY_FILE: manifest, TRACEYARD_REPLAY_STATE: state }))
        .code,
    ).toBe(0);
    const changed = await execute(`await fetch(${JSON.stringify(url + "-changed")})`, {
      TRACEYARD_REPLAY_FILE: manifest,
      TRACEYARD_REPLAY_STATE: state,
    });
    expect(changed.code).not.toBe(0);
    expect(changed.out).toContain("unmatched");
    expect(calls).toBe(1);
    expect(await readFile(state, "utf8")).toContain("divergence");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
