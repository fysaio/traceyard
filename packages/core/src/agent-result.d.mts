/** Bound an MCP tool result to `limit` (the hosted `outputChars` budget). */
export function agentResult(
  value: Record<string, unknown>,
  limit?: number,
): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
};
