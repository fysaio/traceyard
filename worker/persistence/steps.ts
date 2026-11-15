import { nowIso } from "../lib/time";
import type { StepRow } from "./rows";

export interface StepStartResult {
  state: "started" | "already_succeeded" | "terminal";
  step: StepRow | null;
}

/**
 * Claims a step for an attempt. The conditional UPDATE is the concurrency
 * boundary: two attempts cannot both move a step from PENDING to RUNNING.
 */
export async function startStepAttempt(
  db: D1Database,
  options: {
    runId: string;
    stepId: string;
    stepKey: string;
    attemptNumber: number;
    inputJson: string | null;
  },
): Promise<StepStartResult> {
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE execution_steps
          SET status = 'RUNNING',
              started_at = COALESCE(started_at, ?),
              attempt_count = CASE WHEN attempt_count < ? THEN ? ELSE attempt_count END,
              input_json = COALESCE(input_json, ?),
              updated_at = ?
        WHERE id = ? AND run_id = ? AND step_key = ?
          AND status IN ('PENDING', 'RUNNING')`,
    )
    .bind(
      now,
      options.attemptNumber,
      options.attemptNumber,
      options.inputJson,
      now,
      options.stepId,
      options.runId,
      options.stepKey,
    )
    .run();

  if (result.meta.changes === 0) {
    const step = await getStep(db, options.runId, options.stepKey);
    if (step !== null && step.status === "SUCCEEDED") {
      return { state: "already_succeeded", step };
    }
    return { state: "terminal", step };
  }

  await db
    .prepare(
      `INSERT INTO step_attempts (
         id, run_id, step_id, attempt_number, status, started_at, input_json
       ) VALUES (?, ?, ?, ?, 'RUNNING', ?, ?)
       ON CONFLICT (step_id, attempt_number) DO NOTHING`,
    )
    .bind(
      `att_${crypto.randomUUID().replace(/-/g, "")}`,
      options.runId,
      options.stepId,
      options.attemptNumber,
      now,
      options.inputJson,
    )
    .run();

  return { state: "started", step: await getStep(db, options.runId, options.stepKey) };
}

export async function getStep(
  db: D1Database,
  runId: string,
  stepKey: string,
): Promise<StepRow | null> {
  return db
    .prepare(`SELECT * FROM execution_steps WHERE run_id = ? AND step_key = ?`)
    .bind(runId, stepKey)
    .first<StepRow>();
}

export async function completeStep(
  db: D1Database,
  options: {
    runId: string;
    stepId: string;
    stepKey: string;
    attemptNumber: number;
    outputJson: string;
    eventMessage: string;
    eventData?: unknown;
  },
): Promise<{ changed: boolean; outputJson: string | null }> {
  const now = nowIso();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE execution_steps
            SET status = 'SUCCEEDED', output_json = ?, completed_at = ?, updated_at = ?,
                error_json = NULL, error_class = NULL
          WHERE id = ? AND run_id = ? AND step_key = ? AND status = 'RUNNING'`,
      )
      .bind(options.outputJson, now, now, options.stepId, options.runId, options.stepKey),
    db
      .prepare(
        `UPDATE step_attempts
            SET status = 'SUCCEEDED', completed_at = ?, output_json = ?
          WHERE step_id = ? AND attempt_number = ? AND status = 'RUNNING'`,
      )
      .bind(now, options.outputJson, options.stepId, options.attemptNumber),
    db
      .prepare(
        `INSERT INTO execution_events (
           run_id, type, level, message, step_key, attempt_number, data_json, dedupe_key, created_at
         ) VALUES (?, 'step.succeeded', 'info', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .bind(
        options.runId,
        options.eventMessage,
        options.stepKey,
        options.attemptNumber,
        options.eventData === undefined ? null : JSON.stringify(options.eventData),
        `${options.runId}:step.succeeded:${options.stepKey}`,
        now,
      ),
  ]);

  const changed = (results[0]?.meta.changes ?? 0) === 1;
  if (!changed) {
    const step = await getStep(db, options.runId, options.stepKey);
    return { changed: false, outputJson: step?.output_json ?? null };
  }
  return { changed: true, outputJson: options.outputJson };
}

export async function failStepAttempt(
  db: D1Database,
  options: {
    runId: string;
    stepId: string;
    stepKey: string;
    stepName: string;
    attemptNumber: number;
    error: { class: string; code: string; message: string; retryable: boolean };
    isFinalAttempt: boolean;
  },
): Promise<void> {
  const now = nowIso();
  const errorJson = JSON.stringify(options.error);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE step_attempts
            SET status = 'FAILED', error_json = ?, error_class = ?, completed_at = ?
          WHERE step_id = ? AND attempt_number = ? AND status = 'RUNNING'`,
      )
      .bind(errorJson, options.error.class, now, options.stepId, options.attemptNumber),
    db
      .prepare(
        `INSERT INTO execution_events (
           run_id, type, level, message, step_key, attempt_number, data_json, dedupe_key, created_at
         ) VALUES (?, 'step.attempt.failed', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .bind(
        options.runId,
        options.isFinalAttempt ? "error" : "warn",
        options.isFinalAttempt
          ? `Step "${options.stepName}" failed on attempt ${options.attemptNumber}.`
          : `Step "${options.stepName}" attempt ${options.attemptNumber} failed and is eligible for retry.`,
        options.stepKey,
        options.attemptNumber,
        errorJson,
        `${options.runId}:step.attempt.failed:${options.stepKey}:${options.attemptNumber}`,
        now,
      ),
  ];

  if (options.isFinalAttempt) {
    statements.push(
      db
        .prepare(
          `UPDATE execution_steps
              SET status = 'FAILED', error_json = ?, error_class = ?, completed_at = ?, updated_at = ?
            WHERE id = ? AND run_id = ? AND status = 'RUNNING'`,
        )
        .bind(errorJson, options.error.class, now, now, options.stepId, options.runId),
      db
        .prepare(
          `INSERT INTO execution_events (
             run_id, type, level, message, step_key, attempt_number, data_json, dedupe_key, created_at
           ) VALUES (?, 'step.failed', 'error', ?, ?, ?, ?, ?, ?)
           ON CONFLICT (dedupe_key) DO NOTHING`,
        )
        .bind(
          options.runId,
          `Step "${options.stepName}" exhausted its retry policy.`,
          options.stepKey,
          options.attemptNumber,
          errorJson,
          `${options.runId}:step.failed:${options.stepKey}`,
          now,
        ),
    );
  }

  await db.batch(statements);
}

export async function setStepInput(
  db: D1Database,
  runId: string,
  stepKey: string,
  inputJson: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE execution_steps SET input_json = ?, updated_at = ?
        WHERE run_id = ? AND step_key = ? AND status IN ('PENDING', 'RUNNING')`,
    )
    .bind(inputJson, nowIso(), runId, stepKey)
    .run();
}
