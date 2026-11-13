import { nowIso } from "../lib/time";
import type { EventRow } from "./rows";

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

export async function appendEvent(db: D1Database, event: NewEvent): Promise<void> {
  await eventInsertStatement(db, event).run();
}

export async function listEventRows(
  db: D1Database,
  runId: string,
  after: number,
  limit: number,
): Promise<EventRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM execution_events
        WHERE run_id = ? AND seq > ?
        ORDER BY seq ASC LIMIT ?`,
    )
    .bind(runId, after, limit)
    .all<EventRow>();
  return result.results;
}
