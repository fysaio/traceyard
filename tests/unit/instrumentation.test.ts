import { describe, it, expect } from "vitest";
import { TraceyardClient } from "../../sdk/client";
import { spanSchema, redact } from "../../shared/contracts/traces";
describe("instrumentation contracts", () => {
  it("keeps nested context and reports telemetry errors without changing work outcomes", async () => {
    const records: Record<string, unknown>[] = [];
    const client = new TraceyardClient({
      origin: "https://traceyard.test",
      apiKey: "server-key",
      fetch: async (_url, init) => {
        records.push(
          (JSON.parse(String(init?.body)) as { spans: Record<string, unknown>[] }).spans[0]!,
        );
        return Response.json({ data: { accepted: 1 } });
      },
    });
    const value = await client.span("root", (parent) =>
      client.span("child", async () => 42, { parent }),
    );
    expect(value).toBe(42);
    expect(records).toHaveLength(4);
    expect(records[1]!.parentSpanId).toBe(records[0]!.spanId);
    expect(records.every((r) => spanSchema.safeParse(r).success)).toBe(true);
    expect(
      client.parseTraceparent(
        client.traceparent({ traceId: "a".repeat(32), spanId: "b".repeat(16) }),
      ),
    ).toEqual({ traceId: "a".repeat(32), spanId: "b".repeat(16) });
    expect(
      client.parseTraceparent("00-" + "0".repeat(32) + "-" + "a".repeat(16) + "-01"),
    ).toBeUndefined();
    const failed = new TraceyardClient({
      origin: "https://traceyard.test",
      apiKey: "unused",
      fetch: async () => {
        throw Error("network");
      },
      onTelemetryError: () => {
        throw Error("callback");
      },
    });
    await expect(failed.span("operation", async () => 7)).resolves.toBe(7);
    const original = Error("business failure");
    await expect(
      failed.span("operation", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });
  it("redacts token-bearing values and rejects invalid trace time/state", () => {
    expect(redact({ nested: { password: "hidden" }, text: "Bearer abc123" })).toEqual({
      nested: { password: "[redacted]" },
      text: "Bearer [redacted]",
    });
    expect(
      spanSchema.safeParse({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        name: "bad",
        status: "FAILED",
        startedAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});
