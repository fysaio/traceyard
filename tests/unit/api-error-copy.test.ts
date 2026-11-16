import { describe, expect, it } from "vitest";

import { ApiClientError, describeApiError } from "../../src/lib/api";

describe("describeApiError", () => {
  it("explains quota exhaustion, the exact retry window and preserved history", () => {
    const error = new ApiClientError(
      429,
      "SESSION_HOURLY_QUOTA",
      "This session has reached its hourly execution allowance.",
      { scope: "session", limit: 6, used: 6 },
      120,
    );

    const message = describeApiError(error, "fallback");
    expect(message).toContain("hourly execution allowance");
    expect(message).toContain("Capacity returns in about 2 minutes.");
    expect(message).toContain("Existing executions and their history remain available.");
  });

  it("never invents a retry time when the server did not supply one", () => {
    const error = new ApiClientError(
      429,
      "SANDBOX_CONCURRENCY_LIMIT",
      "The sandbox is running its maximum number of executions.",
    );

    const message = describeApiError(error, "fallback");
    expect(message).toContain("maximum number of executions");
    expect(message).not.toContain("Capacity returns");
  });

  it("explains that a manual retry creates a new execution", () => {
    const error = new ApiClientError(409, "RUN_NOT_RETRYABLE", "Only failed runs can be retried.");

    expect(describeApiError(error, "fallback")).toContain("creates a new execution");
  });

  it("tells the operator to use a fresh idempotency key", () => {
    const error = new ApiClientError(
      422,
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used with a different request body.",
    );

    expect(describeApiError(error, "fallback")).toContain("fresh idempotency key");
  });

  it("falls back for errors that are not API failures", () => {
    expect(describeApiError(new Error("socket closed"), "Try again.")).toBe("Try again.");
    expect(describeApiError(null, "Try again.")).toBe("Try again.");
  });
});
