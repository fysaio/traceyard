/**
 * Error classification shared by the execution engine, API and inspector.
 *
 * The class describes *why* an execution failed. It is deliberately distinct
 * from the HTTP status and from the free-form message, which may come from an
 * untrusted dependency.
 */

export const ERROR_CLASSES = [
  "VALIDATION",
  "TRANSIENT_DEPENDENCY",
  "PERMANENT_APPLICATION",
  "TIMEOUT",
  "EXECUTION_INFRASTRUCTURE",
  "CANCELLED",
  "INTERNAL",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

export interface SerializedError {
  class: ErrorClass;
  code: string;
  message: string;
  retryable: boolean;
  stepKey?: string;
  attempt?: number;
}

export class DomainError extends Error {
  readonly errorClass: ErrorClass;
  readonly code: string;
  readonly retryable: boolean;
  readonly safeMessage: string;

  constructor(options: {
    errorClass: ErrorClass;
    code: string;
    message: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DomainError";
    this.errorClass = options.errorClass;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.safeMessage = options.message;
  }
}

export function serializeError(
  error: unknown,
  options: { stepKey?: string; attempt?: number; fallbackClass?: ErrorClass } = {},
): SerializedError {
  const serialized: SerializedError = {
    class: options.fallbackClass ?? "INTERNAL",
    code: "UNEXPECTED_ERROR",
    message: "An unexpected execution error occurred.",
    retryable: false,
  };

  if (error instanceof DomainError) {
    serialized.class = error.errorClass;
    serialized.code = error.code;
    serialized.message = error.safeMessage;
    serialized.retryable = error.retryable;
  } else if (error instanceof Error) {
    serialized.message = safeErrorMessage(error);
    serialized.code = error.name === "Error" ? "UNEXPECTED_ERROR" : sanitizeCode(error.name);
  }

  if (options.stepKey !== undefined) serialized.stepKey = options.stepKey;
  if (options.attempt !== undefined) serialized.attempt = options.attempt;

  return serialized;
}

/**
 * Public errors must not leak database URLs, bindings or stack frames.
 */
export function safeErrorMessage(error: Error): string {
  const message = error.message.trim();
  if (message.length === 0) return "The operation failed without an error message.";
  return message.slice(0, 500);
}

function sanitizeCode(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]+/g, "_").toUpperCase();
  return normalized.length > 0 ? normalized.slice(0, 64) : "UNEXPECTED_ERROR";
}

export function validationError(message: string, code = "INVALID_INPUT"): DomainError {
  return new DomainError({
    errorClass: "VALIDATION",
    code,
    message,
    retryable: false,
  });
}

export function transientDependencyError(message: string, code: string): DomainError {
  return new DomainError({
    errorClass: "TRANSIENT_DEPENDENCY",
    code,
    message,
    retryable: true,
  });
}

export function permanentApplicationError(message: string, code: string): DomainError {
  return new DomainError({
    errorClass: "PERMANENT_APPLICATION",
    code,
    message,
    retryable: false,
  });
}
