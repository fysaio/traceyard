import { afterEach, describe, expect, it, vi } from "vitest";
import { agentKeepAliveStream } from "../../worker/mcp/keep-alive";

afterEach(() => vi.useRealTimers());

describe("MCP compatibility stream", () => {
  it("stays open across heartbeats and releases its timer when cancelled", async () => {
    vi.useFakeTimers();
    const authorize = vi.fn(async () => true);
    const reader = agentKeepAliveStream(new AbortController().signal, authorize).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
    for (let i = 0; i < 6; i++) {
      const frame = reader.read();
      await vi.advanceTimersByTimeAsync(15000);
      const next = await frame;
      expect(next.done).toBe(false);
      expect(new TextDecoder().decode(next.value)).toBe(": keep-alive\n\n");
    }
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
    expect(authorize).toHaveBeenCalledTimes(6);
  });

  it("ends on revoked/expired authorization or request abort", async () => {
    vi.useFakeTimers();
    for (const revoked of [true, false]) {
      const abort = new AbortController();
      const authorize = vi.fn(async () => !revoked);
      const reader = agentKeepAliveStream(abort.signal, authorize).getReader();
      await reader.read();
      const end = reader.read();
      if (revoked) await vi.advanceTimersByTimeAsync(15000);
      else abort.abort();
      expect((await end).done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("bounds buffering for slow readers and stops an in-flight check after cancellation", async () => {
    vi.useFakeTimers();
    const authorize = vi.fn(async () => true);
    const reader = agentKeepAliveStream(new AbortController().signal, authorize).getReader();
    await vi.advanceTimersByTimeAsync(90000);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(15000);
    expect(new TextDecoder().decode((await next).value)).toContain(": keep-alive");
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);

    let resolve!: (allowed: boolean) => void;
    const pending = agentKeepAliveStream(
      new AbortController().signal,
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
        }),
    ).getReader();
    await pending.read();
    await vi.advanceTimersByTimeAsync(15000);
    await pending.cancel();
    resolve(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
