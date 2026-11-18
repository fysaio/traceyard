import { nowIso } from "../lib/time";

export interface NewEvent {
  runId: string;
  type: string;
  level: "info" | "warn" | "error";
  message: string;
  stepKey?: string | null;
  attemptNumber?: number | null;
  data?: unknown;
  dedupeKey: string;
  createdAt?: string;
}

export function eventInsertStatement(db: D1Database, event: NewEvent): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO execution_events (
         run_id, type, level, message, step_key, attempt_number, data_json, dedupe_key, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(
      event.runId,
      event.type,
      event.level,
      event.message,
      event.stepKey ?? null,
      event.attemptNumber ?? null,
      event.data === undefined ? null : JSON.stringify(event.data),
      event.dedupeKey,
      event.createdAt ?? nowIso(),
    );
}
