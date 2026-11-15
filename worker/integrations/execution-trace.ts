import { sha256Hex } from "../lib/crypto";
import { redact } from "../../shared/contracts/traces";
import type { RunRow, StepRow, AttemptRow } from "../persistence/rows";
// An evidence projection: timestamps and values come exclusively from persisted execution records.
// Reading a trace never executes a workflow or invents timing events.
export async function executionTrace(db: D1Database, run: RunRow) {
  const [steps, attempts, models, http] = await Promise.all([
    db
      .prepare("SELECT * FROM execution_steps WHERE run_id=? ORDER BY ordinal")
      .bind(run.id)
      .all<StepRow>(),
    db
      .prepare("SELECT * FROM step_attempts WHERE run_id=? ORDER BY started_at,attempt_number")
      .bind(run.id)
      .all<AttemptRow>(),
    db.prepare("SELECT * FROM model_requests WHERE run_id=? ORDER BY created_at").bind(run.id).all<{
      id: string;
      step_key: string;
      status: string;
      provider: string | null;
      model: string | null;
      created_at: string;
      duration_ms: number;
      attempts_json: string;
      input_tokens: number | null;
      output_tokens: number | null;
    }>(),
    db.prepare("SELECT * FROM http_requests WHERE run_id=? ORDER BY created_at").bind(run.id).all<{
      id: string;
      node_id: string;
      connection_id: string;
      status: string;
      created_at: string;
      duration_ms: number;
      http_status: number | null;
      error: string | null;
    }>(),
  ]);
  const traceId = (await sha256Hex(run.id)).slice(0, 32),
    root = (await sha256Hex("root:" + run.id)).slice(0, 16);
  const json = (value: string | null) =>
    value === null ? null : JSON.stringify(redact(JSON.parse(value)));
  const items = [
    {
      trace_id: traceId,
      span_id: root,
      parent_span_id: null as string | null,
      name: "Workflow execution",
      kind: "workflow",
      status: run.status as string,
      started_at: run.started_at ?? run.created_at,
      ended_at: run.completed_at,
      attributes_json: JSON.stringify({
        runId: run.id,
        workflowId: run.workflow_id,
        version: run.workflow_version,
      }),
      input_json: json(run.input_json),
      output_json: json(run.output_json),
      error_json: json(run.error_json),
    },
  ];
  for (const s of steps.results) {
    if (!s.started_at) continue;
    const id = (await sha256Hex(s.id)).slice(0, 16);
    items.push({
      trace_id: traceId,
      span_id: id,
      parent_span_id: root,
      name: s.name,
      kind: "step",
      status: s.status,
      started_at: s.started_at,
      ended_at: s.completed_at,
      attributes_json: JSON.stringify({ stepKey: s.step_key, attemptCount: s.attempt_count }),
      input_json: json(s.input_json),
      output_json: json(s.output_json),
      error_json: json(s.error_json),
    });
    for (const a of attempts.results.filter((a) => a.step_id === s.id))
      items.push({
        trace_id: traceId,
        span_id: (await sha256Hex(a.id)).slice(0, 16),
        parent_span_id: id,
        name: "Attempt " + a.attempt_number,
        kind: "step",
        status: a.status,
        started_at: a.started_at,
        ended_at: a.completed_at,
        attributes_json: JSON.stringify({ attempt: a.attempt_number }),
        input_json: json(a.input_json ?? null),
        output_json: json(a.output_json ?? null),
        error_json: json(a.error_json),
      });
    for (const h of http.results.filter((h) => h.node_id === s.step_key))
      items.push({
        trace_id: traceId,
        span_id: (await sha256Hex(h.id)).slice(0, 16),
        parent_span_id: id,
        name: "HTTP request",
        kind: "http",
        status: h.status,
        started_at: h.created_at,
        ended_at:
          h.status === "RUNNING"
            ? null
            : new Date(Date.parse(h.created_at) + h.duration_ms).toISOString(),
        attributes_json: JSON.stringify({
          requestId: h.id,
          connectionId: h.connection_id,
          httpStatus: h.http_status,
        }),
        input_json: null,
        output_json: null,
        error_json: h.error ? JSON.stringify(h.error) : null,
      });
    for (const m of models.results.filter((m) => m.step_key === s.step_key))
      items.push({
        trace_id: traceId,
        span_id: (await sha256Hex(m.id)).slice(0, 16),
        parent_span_id: id,
        name: m.model ?? "Model request",
        kind: "model",
        status: m.status,
        started_at: m.created_at,
        ended_at:
          m.status === "RUNNING"
            ? null
            : new Date(Date.parse(m.created_at) + m.duration_ms).toISOString(),
        attributes_json: JSON.stringify({
          requestId: m.id,
          provider: m.provider,
          inputTokens: m.input_tokens,
          outputTokens: m.output_tokens,
          attempts: JSON.parse(m.attempts_json),
        }),
        input_json: null,
        output_json: null,
        error_json: null,
      });
  }
  return items;
}
