import { describe, expect, it } from "vitest";

import {
  DomainError,
  permanentApplicationError,
  safeErrorMessage,
  serializeError,
  transientDependencyError,
  validationError,
} from "../../shared/domain/errors";

describe("serializeError", () => {
  it("preserves a domain error's public fields", () => {
    const error = transientDependencyError("Upstream did not answer.", "UPSTREAM_TIMEOUT");
    const serialized = serializeError(error, { stepKey: "extract-insights", attempt: 2 });
    expect(serialized).toEqual({
      class: "TRANSIENT_DEPENDENCY",
      code: "UPSTREAM_TIMEOUT",
      message: "Upstream did not answer.",
      retryable: true,
      stepKey: "extract-insights",
      attempt: 2,
    });
  });

  it("does not leak internals from an unknown error", () => {
    const serialized = serializeError(new Error("postgres://user:pass@host/db"));
    expect(serialized.code).toBe("UNEXPECTED_ERROR");
    expect(serialized.retryable).toBe(false);
  });

  it("sanitizes non-domain error names into codes", () => {
    class UpstreamBoom extends Error {
      override name = "Upstream Boom!";
    }
    const serialized = serializeError(new UpstreamBoom("failed"));
    expect(serialized.code).toBe("UPSTREAM_BOOM_");
    expect(serialized.message).toBe("failed");
  });

  it("falls back to a generic message for non-errors", () => {
    expect(serializeError("just a string").message).toBe("An unexpected execution error occurred.");
  });

  it("honours a fallback class", () => {
    expect(
      serializeError(new Error("x"), { fallbackClass: "EXECUTION_INFRASTRUCTURE" }).class,
    ).toBe("EXECUTION_INFRASTRUCTURE");
  });
});

describe("safeErrorMessage", () => {
  it("truncates long messages to 500 characters", () => {
    expect(safeErrorMessage(new Error("x".repeat(1_000)))).toHaveLength(500);
  });

  it("describes an empty message", () => {
    expect(safeErrorMessage(new Error("   "))).toBe(
      "The operation failed without an error message.",
    );
  });
});

describe("error factories", () => {
  it("set the expected class and retryability", () => {
    const validation = validationError("bad input", "INVALID");
    expect(validation.errorClass).toBe("VALIDATION");
    expect(validation.retryable).toBe(false);
    expect(validation.code).toBe("INVALID");

    const transient = transientDependencyError("later", "RATE_LIMITED");
    expect(transient.errorClass).toBe("TRANSIENT_DEPENDENCY");
    expect(transient.retryable).toBe(true);

    const permanent = permanentApplicationError("never", "POLICY");
    expect(permanent.errorClass).toBe("PERMANENT_APPLICATION");
    expect(permanent.retryable).toBe(false);
  });

  it("produces a DomainError instance", () => {
    expect(validationError("bad input")).toBeInstanceOf(DomainError);
  });
});
