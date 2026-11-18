import { isoFromNow, nowIso } from "../lib/time";
export async function maintainInvestigations(db: D1Database) {
  const at = nowIso(),
    cutoff = isoFromNow(-30 * 86400000);
  // Ten-minute hosted executions are considered uncertain after fifteen minutes.
  const stale = await db
    .prepare("SELECT id FROM investigations WHERE status='EXECUTING' AND updated_at<? LIMIT 20")
    .bind(isoFromNow(-15 * 60000))
    .all<{ id: string }>();
  for (const { id } of stale.results)
    await db.batch([
      db
        .prepare(
          "UPDATE investigations SET status='BLOCKED',finding_json=?,updated_at=? WHERE id=? AND status='EXECUTING'",
        )
        .bind(
          JSON.stringify({
            summary: "The executor did not deliver a complete result within the execution window.",
            basis: "observed",
            limitations: [
              "The execution outcome is unconfirmed. Work was not repeated automatically.",
            ],
            nextAction: "Inspect the linked check before requesting another attempt.",
          }),
          at,
          id,
        ),
      db
        .prepare(
          "UPDATE investigation_attempts SET status='BLOCKED',updated_at=? WHERE investigation_id=? AND report_json IS NULL AND status IN ('QUEUED','RUNNING')",
        )
        .bind(at, id),
    ]);
  await db.batch([
    db
      .prepare(
        "DELETE FROM investigations WHERE id IN (SELECT id FROM investigations WHERE status!='EXECUTING' AND updated_at<? LIMIT 100)",
      )
      .bind(cutoff),
    db
      .prepare(
        "DELETE FROM repository_indexes WHERE rowid IN (SELECT rowid FROM repository_indexes x WHERE created_at<? AND snapshot_id!=(SELECT snapshot_id FROM repository_indexes newest WHERE newest.project_id=x.project_id AND complete=1 ORDER BY created_at DESC,snapshot_id DESC LIMIT 1) LIMIT 20)",
      )
      .bind(cutoff),
    db.prepare("DELETE FROM oauth_consents WHERE expires_at<?").bind(at),
    db.prepare("DELETE FROM oauth_codes WHERE expires_at<?").bind(at),
    db.prepare("DELETE FROM mcp_access_tokens WHERE expires_at<?").bind(at),
    db
      .prepare("DELETE FROM mcp_refresh_tokens WHERE expires_at<? OR consumed_at IS NOT NULL")
      .bind(at),
    db
      .prepare("DELETE FROM mcp_request_limits WHERE minute<?")
      .bind(isoFromNow(-86400000).slice(0, 16)),
    db
      .prepare(
        "DELETE FROM oauth_clients WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM mcp_grants g WHERE g.client_id=oauth_clients.id)",
      )
      .bind(cutoff),
  ]);
  return { stale: stale.results.length };
}
