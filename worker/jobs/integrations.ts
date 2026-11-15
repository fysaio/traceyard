import { launchRun } from "../services/run-service";
import { getConfig } from "../config";
import { randomId, sha256Hex } from "../lib/crypto";
import { nowIso, isoFromNow } from "../lib/time";
import { decryptSecret } from "../integrations/secrets";
import { outboundUrl } from "../integrations/outbound";
export async function runIntegrationJobs(env: Env, fetcher: typeof fetch = fetch) {
  const now = nowIso();
  const schedules = await env.DB.prepare(
    "SELECT * FROM workflow_schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 20",
  )
    .bind(now)
    .all<{
      id: string;
      project_id: string;
      owner_user_id: string;
      workflow_id: string;
      workflow_version: number;
      input_json: string;
      interval_minutes: number;
      next_run_at: string;
    }>();
  for (const s of schedules.results) {
    const sessionHash = await sha256Hex("schedule:" + s.id);
    await env.DB.prepare(
      "INSERT INTO sandbox_sessions (id_hash,ip_hash,user_agent_hash,created_at,last_seen_at) VALUES (?,?,?,?,?) ON CONFLICT(id_hash) DO UPDATE SET last_seen_at=excluded.last_seen_at",
    )
      .bind(sessionHash, "scheduled", "scheduler", now, now)
      .run();
    try {
      const r = await launchRun(env, {
        session: { idHash: sessionHash, ipHash: "schedule:" + s.owner_user_id, isNew: false },
        userId: s.owner_user_id,
        requestId: randomId("schedule_request"),
        body: {
          workflowId: s.workflow_id,
          projectId: s.project_id,
          version: s.workflow_version,
          input: JSON.parse(s.input_json) as unknown,
          scenario: "success",
        },
        idempotencyKey: "schedule:" + s.id + ":" + s.next_run_at,
        config: getConfig(env),
      });
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO scheduled_dispatches (schedule_id,scheduled_at,run_id) VALUES (?,?,?) ON CONFLICT(schedule_id,scheduled_at) DO NOTHING",
        ).bind(s.id, s.next_run_at, r.result.run.id),
        env.DB.prepare(
          "UPDATE workflow_schedules SET last_error=NULL,next_run_at=?,last_run_id=? WHERE id=? AND next_run_at=?",
        ).bind(isoFromNow(s.interval_minutes * 60000), r.result.run.id, s.id, s.next_run_at),
      ]);
    } catch {
      await env.DB.prepare(
        "UPDATE workflow_schedules SET last_error=?,next_run_at=? WHERE id=? AND next_run_at=?",
      )
        .bind(
          "Scheduled launch failed. Check workflow configuration and execution limits.",
          isoFromNow(5 * 60000),
          s.id,
          s.next_run_at,
        )
        .run();
    }
  }
  // Unique delivery IDs make retries observable and receivers can deduplicate.
  const pending = await env.DB.prepare(
    `SELECT w.id AS webhook_id,w.project_id,r.id AS run_id,r.status,r.workflow_id,r.workflow_version,r.completed_at FROM outgoing_webhooks w JOIN runs r ON r.project_id=w.project_id WHERE w.enabled=1 AND r.status IN ('SUCCEEDED','FAILED','CANCELLED') AND r.completed_at>=w.created_at AND NOT EXISTS(SELECT 1 FROM webhook_deliveries d WHERE d.webhook_id=w.id AND d.run_id=r.id) ORDER BY r.completed_at LIMIT 50`,
  ).all<{
    webhook_id: string;
    project_id: string;
    run_id: string;
    status: string;
    workflow_id: string;
    workflow_version: number;
    completed_at: string;
  }>();
  for (const row of pending.results) {
    const id = randomId("delivery");
    await env.DB.prepare(
      "INSERT INTO webhook_deliveries (id,webhook_id,run_id,next_attempt_at,payload_json) VALUES (?,?,?,?,?) ON CONFLICT(webhook_id,run_id) DO NOTHING",
    )
      .bind(
        id,
        row.webhook_id,
        row.run_id,
        now,
        JSON.stringify({
          id,
          type: "execution.completed",
          runId: row.run_id,
          status: row.status,
          workflowId: row.workflow_id,
          version: row.workflow_version,
          completedAt: row.completed_at,
        }),
      )
      .run();
  }
  const deliveries = await env.DB.prepare(
    "SELECT d.*,w.url,w.secret_ciphertext,w.project_id FROM webhook_deliveries d JOIN outgoing_webhooks w ON w.id=d.webhook_id WHERE w.enabled=1 AND d.status='PENDING' AND d.next_attempt_at<=? ORDER BY d.next_attempt_at LIMIT 20",
  )
    .bind(now)
    .all<{
      id: string;
      project_id: string;
      url: string;
      secret_ciphertext: string;
      payload_json: string;
      attempts: number;
    }>();
  for (const d of deliveries.results) {
    const claimed = await env.DB.prepare(
      "UPDATE webhook_deliveries SET attempts=attempts+1,next_attempt_at=? WHERE id=? AND status='PENDING' AND attempts=? AND next_attempt_at<=? RETURNING attempts",
    )
      .bind(isoFromNow(5 * 60000), d.id, d.attempts, now)
      .first();
    if (!claimed) continue;
    let status: number | null = null,
      error: string | null = null;
    try {
      const endpoint = await env.DB.prepare("SELECT webhook_id FROM webhook_deliveries WHERE id=?")
        .bind(d.id)
        .first<{ webhook_id: string }>();
      const secret = await decryptSecret(
        env,
        d.secret_ciphertext,
        d.project_id + ":webhook:" + endpoint!.webhook_id,
      );
      const timestamp = String(Math.floor(Date.now() / 1000)),
        key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
        signature = new Uint8Array(
          await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(timestamp + "." + d.payload_json),
          ),
        );
      const hex = [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");
      const response = await fetcher(outboundUrl(env, d.url), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json",
          "X-Traceyard-Delivery": d.id,
          "X-Traceyard-Timestamp": timestamp,
          "X-Traceyard-Signature": "sha256=" + hex,
        },
        body: d.payload_json,
      });
      status = response.status;
      await response.body?.cancel();
      if (!response.ok) error = "Receiver returned HTTP " + status;
    } catch {
      error = "Delivery failed or destination is not allowed.";
    }
    await env.DB.prepare(
      "UPDATE webhook_deliveries SET status=?,response_status=?,last_error=?,next_attempt_at=? WHERE id=?",
    )
      .bind(
        error ? (d.attempts + 1 >= 5 ? "FAILED" : "PENDING") : "SUCCEEDED",
        status,
        error,
        isoFromNow(Math.min(3600000, 60000 * 2 ** d.attempts)),
        d.id,
      )
      .run();
  }
  await env.DB.prepare("DELETE FROM api_request_limits WHERE minute<?")
    .bind(isoFromNow(-2 * 3600000).slice(0, 16))
    .run();
  await env.DB.prepare("DELETE FROM trace_spans WHERE received_at<?")
    .bind(isoFromNow(-30 * 86400000))
    .run();
  return { schedules: schedules.results.length, deliveries: deliveries.results.length };
}
