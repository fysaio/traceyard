import type { ApiFailure } from "../../shared/contracts/api";

interface ApiSuccess<T> {
  data: T;
  meta: { requestId: string; replayed?: boolean };
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  /** Parsed `Retry-After` value in seconds, when the server provided one. */
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function readRetryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Turns an API failure into a message that states what happened and what is
 * still possible. It never invents a reset time: the countdown is only shown
 * when the server returned a trustworthy `Retry-After`.
 */
export function describeApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiClientError)) return fallback;

  const retry =
    error.retryAfterSeconds === null
      ? ""
      : ` Capacity returns in about ${formatRetryWindow(error.retryAfterSeconds)}.`;

  switch (error.code) {
    case "GLOBAL_DAILY_QUOTA":
    case "SESSION_DAILY_QUOTA":
    case "SESSION_HOURLY_QUOTA":
    case "IP_HOURLY_QUOTA":
      return `${error.message}${retry} Your existing investigations remain available.`;
    default:
      return error.message;
  }
}

function formatRetryWindow(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiSuccess<T>> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ApiClientError(
        response.status,
        "INVALID_RESPONSE",
        "The server returned an unreadable response.",
      );
    }
  }

  if (!response.ok) {
    const failure = parsed as ApiFailure | null;
    throw new ApiClientError(
      response.status,
      failure?.error.code ?? "REQUEST_FAILED",
      failure?.error.message ?? `Request failed with status ${response.status}.`,
      failure?.error.details,
      readRetryAfter(response),
    );
  }

  if (parsed === null || typeof parsed !== "object" || !("data" in parsed)) {
    throw new ApiClientError(response.status, "INVALID_RESPONSE", "The server returned no data.");
  }

  return parsed as ApiSuccess<T>;
}

export interface AuthUser {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface AuthSession {
  user: AuthUser | null;
  currentSessionId: string | null;
  githubSignInAvailable: boolean;
  sessions: UserSession[];
}

export interface UserSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  repository?: string | null;
}

export const api = {
  authSession: (): Promise<AuthSession> =>
    request<AuthSession>("/api/auth/session").then((body) => body.data),

  logout: (): Promise<void> =>
    request<unknown>("/api/auth/logout", { method: "POST" }).then(() => undefined),

  revokeSession: (id: string): Promise<void> =>
    request<unknown>(`/api/auth/sessions/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
    }).then(() => undefined),

  projects: (): Promise<ProjectSummary[]> =>
    request<{ items: ProjectSummary[] }>("/api/projects").then((body) => body.data.items),
};

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
