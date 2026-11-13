import { describe, expect, it } from "vitest";

import { decodeRunCursor, encodeRunCursor } from "../../shared/domain/cursor";

describe("run cursor", () => {
  it("round-trips an ordering key", () => {
    const cursor = {
      createdAt: "2026-11-13T10:00:00.000Z",
      id: "run_0123456789abcdef0123456789abcdef",
    };
    const encoded = encodeRunCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRunCursor(encoded)).toEqual(cursor);
  });

  it("rejects malformed encodings without throwing", () => {
    expect(decodeRunCursor("")).toBeNull();
    expect(decodeRunCursor("not base64!")).toBeNull();
    expect(decodeRunCursor("a")).toBeNull();
    expect(decodeRunCursor(encodeBase64("[]"))).toBeNull();
    expect(decodeRunCursor(encodeBase64("null"))).toBeNull();
  });

  it("rejects unknown cursor versions", () => {
    expect(decodeRunCursor(encodeBase64(JSON.stringify({ v: 2, c: "x", i: "y" })))).toBeNull();
  });

  it("rejects oversized fields to bound the input", () => {
    const longId = "x".repeat(81);
    const longDate = "x".repeat(41);
    expect(
      decodeRunCursor(encodeBase64(JSON.stringify({ v: 1, c: "2026-01-01", i: longId }))),
    ).toBeNull();
    expect(
      decodeRunCursor(encodeBase64(JSON.stringify({ v: 1, c: longDate, i: "run_1" }))),
    ).toBeNull();
  });

  it("rejects non-string fields", () => {
    expect(decodeRunCursor(encodeBase64(JSON.stringify({ v: 1, c: 1, i: "run_1" })))).toBeNull();
  });
});

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
