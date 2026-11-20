/* Envelope shared by every JSON API response. */

export interface ApiSuccess<T> {
  data: T;
  meta: { requestId: string };
}

export interface ApiFailure {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export interface HealthPayload {
  revision?: string | null;
  status: "ok" | "degraded";
  version: string;
  environment: "development" | "production";
  timestamp: string;
  checks: {
    database: { status: "ok" | "error"; latencyMs: number | null };
  };
}
