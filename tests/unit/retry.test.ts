import { describe, expect, it } from "vitest";

import { retryDelayMs, workflowRetryLimit, type RetryPolicy } from "../../shared/domain/retry";

const exponential: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  backoff: "exponential",
  maxDelayMs: 8_000,
};

describe("retryDelayMs", () => {
  it("keeps a fixed delay constant", () => {
    const policy: RetryPolicy = { ...exponential, backoff: "fixed" };
    expect(retryDelayMs(policy, 1)).toBe(1_000);
    expect(retryDelayMs(policy, 4)).toBe(1_000);
  });

  it("treats linear backoff as doubling from the base delay", () => {
    const policy: RetryPolicy = { ...exponential, backoff: "linear" };
    expect(retryDelayMs(policy, 1)).toBe(1_000);
    expect(retryDelayMs(policy, 2)).toBe(2_000);
    expect(retryDelayMs(policy, 3)).toBe(4_000);
  });

  it("doubles exponentially", () => {
    expect(retryDelayMs(exponential, 1)).toBe(1_000);
    expect(retryDelayMs(exponential, 2)).toBe(2_000);
    expect(retryDelayMs(exponential, 3)).toBe(4_000);
    expect(retryDelayMs(exponential, 4)).toBe(8_000);
  });

  it("clamps to maxDelayMs", () => {
    const policy: RetryPolicy = { ...exponential, maxDelayMs: 3_000 };
    expect(retryDelayMs(policy, 3)).toBe(3_000);
    expect(retryDelayMs(policy, 10)).toBe(3_000);
  });

  it("rejects a failed attempt number below one", () => {
    expect(() => retryDelayMs(exponential, 0)).toThrow(RangeError);
    expect(() => retryDelayMs(exponential, -1)).toThrow(RangeError);
  });
});

describe("workflowRetryLimit", () => {
  it("converts maxAttempts into the Workflows retry limit", () => {
    expect(workflowRetryLimit({ ...exponential, maxAttempts: 1 })).toBe(0);
    expect(workflowRetryLimit({ ...exponential, maxAttempts: 3 })).toBe(2);
  });

  it("never returns a negative limit", () => {
    expect(workflowRetryLimit({ ...exponential, maxAttempts: 0 })).toBe(0);
  });
});
