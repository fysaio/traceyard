import { nowIso } from "../lib/time";

export interface AuditInput {
  projectId: string;
  actorType: "anonymous" | "system" | "user";
  actorIdHash: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata?: unknown;
  requestId: string;
}

export async function appendAudit(db: D1Database, input: AuditInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_events (
         project_id, actor_type, actor_id_hash, action, target_type, target_id,
         metadata_json, request_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.projectId,
      input.actorType,
      input.actorIdHash,
      input.action,
      input.targetType,
      input.targetId,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
      input.requestId,
      nowIso(),
    )
    .run();
}
