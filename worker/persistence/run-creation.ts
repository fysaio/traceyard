import { nowIso } from "../lib/time";

export interface NewStepDefinition {
  id: string;
  key: string;
  name: string;
  ordinal: number;
  maxAttempts: number;
}

export interface NewRunBundle {
  httpConnections?: { nodeId: string; json: string }[];
  modelRoutes?: { nodeId: string; routeId: string; routeJson: string }[];
  run: {
    id: string;
    projectId: string;
    workflowId: string;
    workflowVersion: number;
    triggerSource: "sandbox" | "api" | "retry";
    scenario: string;
    visibility: "private" | "public";
    ownerSessionHash: string;
    ownerUserId: string | null;
    ownerIpHash: string;
    parentRunId: string | null;
    retryOfRunId: string | null;
    idempotencyKey: string | null;
    inputHash: string;
    inputJson: string;
    correlationId: string;
    createdAt: string;
    expiresAt: string;
  };
  steps: NewStepDefinition[];
  dispatch: { id: string; availableAt: string };
  idempotency: {
    scope: string;
    key: string;
    requestHash: string;
    expiresAt: string;
  } | null;
  events: Array<{
    type: string;
    level: "info" | "warn" | "error";
    message: string;
    stepKey?: string;
    data?: unknown;
    dedupeKey: string;
  }>;
  audit: {
    projectId: string;
    actorType: "anonymous" | "system" | "user";
    actorIdHash: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: unknown;
    requestId: string;
  };
  retryLink: { originalRunId: string } | null;
}

/**
 * Writes a run, its step plan, dispatch record, initial events, optional
 * idempotency record and audit entry in one D1 batch. D1 executes a batch as a
 * transaction, so a run is never persisted without its dispatch outbox row.
 */
export async function insertRunBundle(db: D1Database, bundle: NewRunBundle): Promise<void> {
  const now = nowIso();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO runs (
           id, project_id, workflow_id, workflow_version, status, trigger_source, scenario,
           visibility, owner_session_hash, owner_user_id, owner_ip_hash, parent_run_id, retry_of_run_id,
           idempotency_key, input_hash, input_json, correlation_id, created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        bundle.run.id,
        bundle.run.projectId,
        bundle.run.workflowId,
        bundle.run.workflowVersion,
        bundle.run.triggerSource,
        bundle.run.scenario,
        bundle.run.visibility,
        bundle.run.ownerSessionHash,
        bundle.run.ownerUserId,
        bundle.run.ownerIpHash,
        bundle.run.parentRunId,
        bundle.run.retryOfRunId,
        bundle.run.idempotencyKey,
        bundle.run.inputHash,
        bundle.run.inputJson,
        bundle.run.correlationId,
        bundle.run.createdAt,
        bundle.run.createdAt,
        bundle.run.expiresAt,
      ),
  ];

  for (const connection of bundle.httpConnections ?? [])
    statements.push(
      db
        .prepare("INSERT INTO run_http_connections (run_id,node_id,connection_json) VALUES (?,?,?)")
        .bind(bundle.run.id, connection.nodeId, connection.json),
    );
  for (const route of bundle.modelRoutes ?? [])
    statements.push(
      db
        .prepare(
          "INSERT INTO run_model_routes (run_id,node_id,route_id,route_json) VALUES (?,?,?,?)",
        )
        .bind(bundle.run.id, route.nodeId, route.routeId, route.routeJson),
    );
  for (const step of bundle.steps) {
    statements.push(
      db
        .prepare(
          `INSERT INTO execution_steps (
             id, run_id, step_key, name, ordinal, status, max_attempts,
             attempt_count, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, 0, ?)`,
        )
        .bind(step.id, bundle.run.id, step.key, step.name, step.ordinal, step.maxAttempts, now),
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO execution_dispatches (
           id, run_id, status, attempt_count, available_at, created_at, updated_at
         ) VALUES (?, ?, 'PENDING', 0, ?, ?, ?)`,
      )
      .bind(bundle.dispatch.id, bundle.run.id, bundle.dispatch.availableAt, now, now),
  );

  for (const event of bundle.events) {
    statements.push(
      db
        .prepare(
          `INSERT INTO execution_events (
             run_id, type, level, message, step_key, data_json, dedupe_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (dedupe_key) DO NOTHING`,
        )
        .bind(
          bundle.run.id,
          event.type,
          event.level,
          event.message,
          event.stepKey ?? null,
          event.data === undefined ? null : JSON.stringify(event.data),
          event.dedupeKey,
          now,
        ),
    );
  }

  if (bundle.idempotency !== null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO idempotency_records (scope, key, request_hash, run_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          bundle.idempotency.scope,
          bundle.idempotency.key,
          bundle.idempotency.requestHash,
          bundle.run.id,
          now,
          bundle.idempotency.expiresAt,
        ),
    );
  }

  if (bundle.retryLink !== null) {
    statements.push(
      db
        .prepare(
          `UPDATE runs SET retry_run_id = ?, updated_at = ?
            WHERE id = ? AND status = 'FAILED' AND retry_run_id IS NULL`,
        )
        .bind(bundle.run.id, now, bundle.retryLink.originalRunId),
      db
        .prepare(
          `INSERT INTO execution_events (
             run_id, type, level, message, data_json, dedupe_key, created_at
           ) VALUES (?, 'run.retry.created', 'info', ?, ?, ?, ?)
           ON CONFLICT (dedupe_key) DO NOTHING`,
        )
        .bind(
          bundle.retryLink.originalRunId,
          `A retry run was created as ${bundle.run.id}.`,
          JSON.stringify({ retryRunId: bundle.run.id }),
          `${bundle.retryLink.originalRunId}:run.retry.created`,
          now,
        ),
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO audit_events (
           project_id, actor_type, actor_id_hash, action, target_type, target_id,
           metadata_json, request_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        bundle.audit.projectId,
        bundle.audit.actorType,
        bundle.audit.actorIdHash,
        bundle.audit.action,
        bundle.audit.targetType,
        bundle.audit.targetId,
        bundle.audit.metadata === undefined ? null : JSON.stringify(bundle.audit.metadata),
        bundle.audit.requestId,
        now,
      ),
  );

  await db.batch(statements);
}
