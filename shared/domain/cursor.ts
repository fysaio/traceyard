/**
 * Opaque, stable pagination cursors. Cursors are base64url-encoded JSON so the
 * client treats them as opaque and cannot forge an ordering key.
 */

export interface RunCursor {
  createdAt: string;
  id: string;
}

export function encodeRunCursor(cursor: RunCursor): string {
  return encodeBase64Url(JSON.stringify({ v: 1, c: cursor.createdAt, i: cursor.id }));
}

export function decodeRunCursor(value: string): RunCursor | null {
  try {
    const parsed: unknown = JSON.parse(decodeBase64Url(value));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record["v"] !== 1) return null;
    if (typeof record["c"] !== "string" || typeof record["i"] !== "string") return null;
    if (record["c"].length > 40 || record["i"].length > 80) return null;
    return { createdAt: record["c"], id: record["i"] };
  } catch {
    return null;
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 512) {
    throw new Error("Invalid cursor encoding");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + padding);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
