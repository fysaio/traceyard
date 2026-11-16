import type {
  AnalyticsPayload,
  ApiFailure,
  CancelRunResult,
  EventListPage,
  HealthPayload,
  LaunchRunResult,
  OverviewPayload,
  RetryRunResult,
  RunDetail,
  RunListPage,
  SandboxStatus,
  WorkflowSummary,
} from "../../shared/contracts/api";
import type { RunStatus } from "../../shared/domain/status";
import type { FailureScenario } from "../../shared/workflow/document";

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
    case "SANDBOX_CONCURRENCY_LIMIT":
      return `${error.message} Your existing executions and their history remain available.`;
    case "GLOBAL_DAILY_QUOTA":
    case "SESSION_DAILY_QUOTA":
    case "SESSION_HOURLY_QUOTA":
    case "IP_HOURLY_QUOTA":
      return `${error.message}${retry} Existing executions and their history remain available.`;
    case "SANDBOX_CIRCUIT_OPEN":
    case "SANDBOX_DISABLED":
      return `${error.message}${retry} Existing executions and their history remain available.`;
    case "IDEMPOTENCY_KEY_REUSED":
      return `${error.message} Start a new launch with a fresh idempotency key.`;
    case "IDEMPOTENCY_RECORD_UNAVAILABLE":
      return `${error.message} Start a new launch to create a new execution.`;
    case "RETRY_ALREADY_EXISTS":
      return `${error.message} Open the existing retry execution instead.`;
    case "RUN_NOT_RETRYABLE":
      return `${error.message} Only terminal failures can be retried, and a retry creates a new execution.`;
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

export interface RunListParams {
  status?: RunStatus | undefined;
  workflowId?: string | undefined;
  projectId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
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

export interface SavedWorkflowSummary {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  description: string;
  definition: unknown;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  authSession: (): Promise<AuthSession> =>
    request<AuthSession>("/api/auth/session").then((body) => body.data),

  logout: (): Promise<void> =>
    request<unknown>("/api/auth/logout", { method: "POST" }).then(() => undefined),

  claim: (projectId?: string): Promise<{ claimedRuns: number }> =>
    request<{ claimedRuns: number }>("/api/auth/claim", {
      method: "POST",
      ...(projectId ? { body: JSON.stringify({ projectId }) } : {}),
    }).then((body) => body.data),

  revokeSession: (id: string): Promise<void> =>
    request<unknown>(`/api/auth/sessions/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
    }).then(() => undefined),

  projects: (): Promise<ProjectSummary[]> =>
    request<{ items: ProjectSummary[] }>("/api/projects").then((body) => body.data.items),

  createProject: (name: string): Promise<ProjectSummary> =>
    request<ProjectSummary>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    }).then((body) => body.data),

  savedWorkflows: (projectId: string): Promise<SavedWorkflowSummary[]> =>
    request<{ items: SavedWorkflowSummary[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows`,
    ).then((body) => body.data.items),

  createSavedWorkflow: (
    projectId: string,
    input: { name: string; description: string; definition: Record<string, unknown> },
  ): Promise<SavedWorkflowSummary> =>
    request<SavedWorkflowSummary>(`/api/projects/${encodeURIComponent(projectId)}/workflows`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((body) => body.data),

  deleteSavedWorkflow: (projectId: string, workflowId: string): Promise<void> =>
    request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
      { method: "DELETE" },
    ).then(() => undefined),

  health: (): Promise<HealthPayload> =>
    request<HealthPayload>("/api/health").then((body) => body.data),

  workflows: (projectId?: string): Promise<WorkflowSummary[]> =>
    request<{ items: WorkflowSummary[] }>(
      "/api/workflows" + (projectId ? "?projectId=" + encodeURIComponent(projectId) : ""),
    ).then((body) => body.data.items),

  workflow: (id: string, projectId?: string, version?: number): Promise<WorkflowSummary> =>
    request<WorkflowSummary>(
      `/api/workflows/${encodeURIComponent(id)}?${new URLSearchParams({ ...(projectId ? { projectId } : {}), ...(version ? { version: String(version) } : {}) })}`,
    ).then((body) => body.data),

  overview: (days: number): Promise<OverviewPayload> =>
    request<OverviewPayload>(`/api/overview?days=${days}`).then((body) => body.data),

  analytics: (days: number): Promise<AnalyticsPayload> =>
    request<AnalyticsPayload>(`/api/analytics?days=${days}`).then((body) => body.data),

  sandbox: (): Promise<SandboxStatus> =>
    request<SandboxStatus>("/api/sandbox").then((body) => body.data),

  runs: (params: RunListParams = {}): Promise<RunListPage> => {
    const search = new URLSearchParams();
    if (params.status !== undefined) search.set("status", params.status);
    if (params.workflowId !== undefined) search.set("workflowId", params.workflowId);
    if (params.projectId) search.set("projectId", params.projectId);
    if (params.cursor !== undefined) search.set("cursor", params.cursor);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    const query = search.toString();
    return request<RunListPage>(`/api/runs${query.length === 0 ? "" : `?${query}`}`).then(
      (body) => body.data,
    );
  },

  run: (id: string): Promise<RunDetail> =>
    request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`).then((body) => body.data),

  events: (id: string, after = 0): Promise<EventListPage> =>
    request<EventListPage>(
      `/api/runs/${encodeURIComponent(id)}/events?after=${after}&limit=200`,
    ).then((body) => body.data),

  launch: (
    input: {
      workflowId: string;
      projectId?: string;
      version?: number;
      input: unknown;
      scenario: FailureScenario;
    },
    idempotencyKey: string,
  ): Promise<{ result: LaunchRunResult; replayed: boolean }> =>
    request<LaunchRunResult>("/api/runs", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    }).then((body) => ({ result: body.data, replayed: body.meta.replayed === true })),

  cancel: (id: string): Promise<CancelRunResult> =>
    request<CancelRunResult>(`/api/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }).then((body) => body.data),

  retry: (id: string): Promise<RetryRunResult> =>
    request<RetryRunResult>(`/api/runs/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    }).then((body) => body.data),
};

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Retrieve every persisted event page for inspection/export, without truncating at 200. */
export async function readAllEvents(id: string): Promise<EventListPage> {
  const items: EventListPage["items"] = [];
  let cursor = 0;
  for (;;) {
    const page = await api.events(id, cursor);
    items.push(...page.items);
    if (page.nextCursor === null) return { items, nextCursor: null };
    if (page.nextCursor <= cursor) {
      throw new ApiClientError(502, "INVALID_EVENT_CURSOR", "Event pagination did not advance.");
    }
    cursor = page.nextCursor;
  }
}
