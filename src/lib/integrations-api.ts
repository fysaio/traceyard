import type { ModelResult, ModelRouteConfig } from "../../shared/contracts/gateway";
export async function integrationRequest<T>(
  project: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/projects/${encodeURIComponent(project)}/${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = (await response.json()) as { data: T; error?: { message: string } };
  if (!response.ok) throw new Error(result.error?.message ?? "Request failed.");
  return result.data;
}
export interface RouteRecord {
  id: string;
  name: string;
  revision: number;
  config_json: string;
}
export interface GatewayData {
  secretStorageConfigured: boolean;
  credentials: { provider: string; updated_at: string }[];
  routes: RouteRecord[];
  requests: {
    id: string;
    route_id: string;
    provider: string | null;
    model: string | null;
    status: string;
    input_tokens: number | null;
    output_tokens: number | null;
    duration_ms: number;
    estimated_cost_usd: number | null;
    attempts_json: string;
    created_at: string;
  }[];
}
export interface KeyRecord {
  id: string;
  prefix: string;
  name: string;
  revoked_at: string | null;
  expires_at: string;
  scopes_json: string;
  last_used_at: string | null;
}
export interface Approval {
  id: string;
  run_id: string;
  node_id: string;
  prompt: string;
  payload_json: string;
  status: string;
  expires_at: string;
  decision_note: string | null;
}
export interface TraceRecord {
  trace_id: string;
  name: string;
  started_at: string;
  ended_at: string | null;
  span_count: number;
  failed: number;
  running: number;
}
export interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  attributes_json: string;
  input_json: string | null;
  output_json: string | null;
  error_json: string | null;
}
export interface AutomationsData {
  allowedHosts: string[];
  schedules: {
    id: string;
    workflow_id: string;
    workflow_version: number;
    interval_minutes: number;
    enabled: number;
    next_run_at: string;
    last_run_id: string | null;
    last_error: string | null;
  }[];
  webhooks: { id: string; url: string; enabled: number }[];
  deliveries: {
    id: string;
    run_id: string;
    webhook_id: string;
    status: string;
    attempts: number;
    response_status: number | null;
    last_error: string | null;
    next_attempt_at: string;
  }[];
}
export interface ExperimentConfig {
  workflowId: string;
  version: number;
  input: unknown;
  scenario: "success" | "retryable_failure" | "permanent_failure";
  repetitions: number;
  expectedStatus: "SUCCEEDED" | "FAILED" | "CANCELLED";
  outputPath: string;
  expectedValue?: unknown;
  maxDurationMs?: number;
}
export interface Experiment {
  id: string;
  name: string;
  createdAt: string;
  config: ExperimentConfig;
  runs: {
    id: string;
    ordinal: number;
    status: string;
    duration_ms: number | null;
    verdict: { status: string; checks: { name: string; passed: boolean }[] };
  }[];
}
export const integrations = {
  gateway: (p: string) => integrationRequest<GatewayData>(p, "gateway"),
  route: (p: string, config: ModelRouteConfig) =>
    integrationRequest<{ id: string }>(p, "gateway/routes", "POST", config),
  play: (p: string, routeId: string, prompt: string) =>
    integrationRequest<ModelResult>(p, "gateway/playground", "POST", { routeId, prompt }),
  keys: (p: string) => integrationRequest<{ items: KeyRecord[] }>(p, "keys"),
  approvals: (p: string) => integrationRequest<{ items: Approval[] }>(p, "approvals"),
  traces: (p: string) => integrationRequest<{ items: TraceRecord[] }>(p, "traces"),
  spans: (p: string, id: string) =>
    integrationRequest<{ items: SpanRecord[] }>(p, "traces/" + encodeURIComponent(id)),
  automations: (p: string) => integrationRequest<AutomationsData>(p, "automations"),
  experiments: (p: string) => integrationRequest<{ items: Experiment[] }>(p, "experiments"),
};
