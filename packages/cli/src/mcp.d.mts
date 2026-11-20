import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export function createLocalServer(options?: {
  repo?: string;
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
}): McpServer;
export function serveMcp(options?: {
  repo?: string;
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
}): Promise<void>;
