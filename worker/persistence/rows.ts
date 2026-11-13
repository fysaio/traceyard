import type { ErrorClass } from "../../shared/domain/errors";
import type { AttemptStatus, RunStatus, StepStatus } from "../../shared/domain/status";
import type { FailureScenario } from "../../shared/workflow/document";

export interface RunRow {
  id: string;
  project_id: string;
  workflow_id: string;
  workflow_version: number;
  status: RunStatus;
  trigger_source: "sandbox" | "api" | "retry";
  scenario: FailureScenario;
  visibility: "private" | "public";
  owner_session_hash: string | null;
  owner_ip_hash: string | null;
  parent_run_id: string | null;
  retry_of_run_id: string | null;
  retry_run_id: string | null;
  idempotency_key: string | null;
  input_hash: string;
  input_json: string;
  output_json: string | null;
  error_json: string | null;
  error_class: ErrorClass | null;
  correlation_id: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancel_requested_at: string | null;
  expires_at: string;
}

export interface RunWithWorkflowRow extends RunRow {
  workflow_slug: string;
  workflow_name: string;
  workflow_project_id: string;
}

export interface StepRow {
  id: string;
  run_id: string;
  step_key: string;
  name: string;
  ordinal: number;
  status: StepStatus;
  max_attempts: number;
  attempt_count: number;
  input_json: string | null;
  output_json: string | null;
  error_json: string | null;
  error_class: ErrorClass | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface AttemptRow {
  id: string;
  run_id: string;
  step_id: string;
  attempt_number: number;
  status: AttemptStatus;
  error_json: string | null;
  error_class: ErrorClass | null;
  started_at: string;
  completed_at: string | null;
}

export interface EventRow {
  seq: number;
  run_id: string;
  type: string;
  level: "info" | "warn" | "error";
  message: string;
  step_key: string | null;
  attempt_number: number | null;
  data_json: string | null;
  dedupe_key: string | null;
  created_at: string;
}

export interface DispatchRow {
  id: string;
  run_id: string;
  status: "PENDING" | "PUBLISHED" | "CLAIMED" | "FAILED" | "CANCELLED";
  attempt_count: number;
  last_error: string | null;
  available_at: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  claimed_at: string | null;
}

export interface WorkflowRow {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  description: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowVersionRow {
  id: string;
  workflow_id: string;
  version: number;
  input_schema_json: string;
  steps_json: string;
  checksum: string;
  created_at: string;
}

export interface SandboxSessionRow {
  id_hash: string;
  ip_hash: string;
  user_agent_hash: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface StepStatusCountRow {
  run_id: string;
  status: StepStatus;
  count: number;
}

export interface StatusCountRow {
  status: RunStatus;
  count: number;
}

export interface DispatchSummaryRow {
  run_id: string;
  status: DispatchRow["status"];
  attempt_count: number;
  last_error: string | null;
  published_at: string | null;
  claimed_at: string | null;
}
