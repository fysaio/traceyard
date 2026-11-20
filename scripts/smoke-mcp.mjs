#!/usr/bin/env node
// Starts an installed `traceyard mcp` and checks it lists the six local tools.
//   node scripts/smoke-mcp.mjs path/to/traceyard
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bin = process.argv[2];
if (!bin) throw Error("Usage: node scripts/smoke-mcp.mjs <traceyard bin>");
const client = new Client({ name: "traceyard-smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.platform === "win32" ? "cmd" : bin,
    args: process.platform === "win32" ? ["/c", bin, "mcp"] : ["mcp"],
    stderr: "inherit",
  }),
);
const { tools } = await client.listTools();
assert.deepEqual(tools.map((tool) => tool.name).sort(), [
  "check",
  "explain",
  "guard",
  "inspect",
  "reproduce",
  "verify",
]);
const inspected = await client.callTool({ name: "inspect", arguments: { repo: process.cwd() } });
assert.ok(Array.isArray(inspected.content) && inspected.content.length > 0);
await client.close();
console.log(`MCP server OK: ${tools.length} tools.`);
