import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodType } from "zod";

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    details?: unknown,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export function badRequest(code: string, message: string, details?: unknown): ApiError {
  return new ApiError(400, code, message, details);
}

export function notFound(message = "The requested resource was not found."): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

export function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}

export function forbidden(code: string, message: string): ApiError {
  return new ApiError(403, code, message);
}

export function unauthorized(code: string, message: string): ApiError {
  return new ApiError(401, code, message);
}

export function tooManyRequests(
  code: string,
  message: string,
  retryAfterSeconds?: number,
  details?: unknown,
): ApiError {
  const headers =
    retryAfterSeconds === undefined ? undefined : { "Retry-After": String(retryAfterSeconds) };
  return new ApiError(429, code, message, details, headers);
}

export function serviceUnavailable(
  code: string,
  message: string,
  retryAfterSeconds?: number,
  details?: unknown,
): ApiError {
  const headers =
    retryAfterSeconds === undefined ? undefined : { "Retry-After": String(retryAfterSeconds) };
  return new ApiError(503, code, message, details, headers);
}

export function parseWith<T>(schema: ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(
      "VALIDATION_ERROR",
      message,
      parsed.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}
