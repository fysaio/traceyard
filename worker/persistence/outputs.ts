import { nowIso } from "../lib/time";

/**
 * The commit step's idempotency boundary. The `run_id` primary key means a
 * replayed workflow can never create a second committed result; it reads and
 * verifies the existing row instead.
 */
export async function commitWorkflowOutput(
  db: D1Database,
  options: { runId: string; digest: string; outputJson: string },
): Promise<{ outputJson: string; created: boolean }> {
  const result = await db
    .prepare(
      `INSERT INTO workflow_outputs (run_id, digest, output_json, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (run_id) DO NOTHING`,
    )
    .bind(options.runId, options.digest, options.outputJson, nowIso())
    .run();

  const row = await db
    .prepare(`SELECT digest, output_json FROM workflow_outputs WHERE run_id = ?`)
    .bind(options.runId)
    .first<{ digest: string; output_json: string }>();

  if (row === null) {
    throw new Error("Committed output could not be read back.");
  }
  if (row.digest !== options.digest) {
    throw new Error("Committed output digest does not match the verified extraction.");
  }
  return { outputJson: row.output_json, created: result.meta.changes === 1 };
}
