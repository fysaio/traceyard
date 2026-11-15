#!/usr/bin/env node
import { URL } from "node:url";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2),
  command = args.shift(),
  id = args[0]?.startsWith("--") ? undefined : args.shift();
const usage =
  "Usage: node scripts/traceyard.mjs run <workflow-id> --input input.json [--version 1] [--idempotency-key key]\n       node scripts/traceyard.mjs inspect <run-id>\n       node scripts/traceyard.mjs cancel <run-id>\n       node scripts/traceyard.mjs list [--cursor cursor]\nSet TRACEYARD_ORIGIN and TRACEYARD_KEY in your server environment.";
async function main() {
  if (!["run", "inspect", "cancel", "list"].includes(command) || (command !== "list" && !id))
    throw Error(usage);
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || !args[i + 1]) throw Error(usage);
    options.set(args[i], args[i + 1]);
  }
  const url = new URL(process.env.TRACEYARD_ORIGIN ?? "http://localhost:5173");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  )
    throw Error("TRACEYARD_ORIGIN must use HTTPS or localhost.");
  const token = process.env.TRACEYARD_KEY;
  if (!token) throw Error("Set TRACEYARD_KEY in the environment.");
  let path = "/runs",
    method = "GET",
    body,
    headers = { Authorization: "Bearer " + token, Accept: "application/json" };
  if (command === "run") {
    if (!options.has("--input")) throw Error("Provide --input with a JSON file path.");
    const file = await readFile(options.get("--input"), "utf8");
    if (Buffer.byteLength(file) > 24000) throw Error("Input file exceeds 24 KB.");
    body = {
      workflowId: id,
      input: JSON.parse(file),
      scenario: "success",
      ...(options.has("--version") ? { version: Number(options.get("--version")) } : {}),
    };
    method = "POST";
    headers = {
      ...headers,
      "Content-Type": "application/json",
      "Idempotency-Key": options.get("--idempotency-key") ?? randomUUID(),
    };
  } else if (command === "inspect") path += "/" + encodeURIComponent(id);
  else if (command === "cancel") {
    path += "/" + encodeURIComponent(id) + "/cancel";
    method = "POST";
  } else if (options.has("--cursor"))
    path += "?cursor=" + encodeURIComponent(options.get("--cursor"));
  const response = await fetch(url.origin + "/api/v1" + path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.message ?? "Request failed: " + response.status);
  console.log(JSON.stringify(result.data, null, 2));
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Request failed.");
  process.exitCode = 1;
});
