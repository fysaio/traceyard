import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { SandboxStatus } from "../../shared/contracts/api";
import { isoFromNow, nowIso } from "../../worker/lib/time";
import { getDispatchByRunId } from "../../worker/persistence/dispatches";
import { getFlag } from "../../worker/persistence/quotas";
import { getRunRow } from "../../worker/persistence/runs";
import { runScheduledJobs } from "../../worker/jobs/scheduled";
import { apiFetch, createSession, launchRun, readFailure, readSuccess, seedRun } from "./helpers";

describe("scheduled reconciliation", () => {
  it("republishes a pending dispatch and closes one whose run already started", async () => {
    const session = await createSession();
    const queued = await seedRun({ session });
    await env.DB.prepare(`UPDATE execution_dispatches SET available_at = ? WHERE run_id = ?`)
      .bind(isoFromNow(-60_000), queued.runId)
      .run();

    const started = await seedRun({ session, status: "FAILED" });
    await env.DB.prepare(
      `UPDATE execution_dispatches SET status = 'PENDING', available_at = ?
        WHERE run_id = ?`,
    )
      .bind(isoFromNow(-60_000), started.runId)
      .run();

    const summary = await runScheduledJobs(env);
    expect(summary.republished).toBeGreaterThanOrEqual(1);
    expect(summary.failedDispatches).toBe(0);

    const published = await getDispatchByRunId(env.DB, queued.runId);
    expect(published?.status).toBe("PUBLISHED");
    expect(published?.attempt_count).toBe(1);

    const closed = await getDispatchByRunId(env.DB, started.runId);
    expect(closed?.status).toBe("CLAIMED");
  });

  it("reopens a stale claim so the dispatch can be delivered again", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    const stale = isoFromNow(-10 * 60 * 1000);
    await env.DB.prepare(
      `UPDATE execution_dispatches
          SET status = 'CLAIMED', claimed_at = ?, updated_at = ?
        WHERE run_id = ?`,
    )
      .bind(stale, stale, runId)
      .run();

    const summary = await runScheduledJobs(env);
    expect(summary.reopenedClaims).toBe(1);

    const dispatch = await getDispatchByRunId(env.DB, runId);
    expect(dispatch?.status).toBe("PUBLISHED");
  });

  it("gives the final eligible publication time to be consumed", async () => {
    const { runId } = await seedRun({ session: await createSession() });
    await env.DB.prepare(
      "UPDATE execution_dispatches SET attempt_count=5, available_at=? WHERE run_id=?",
    )
      .bind(isoFromNow(-1000), runId)
      .run();

    const summary = await runScheduledJobs(env);

    expect(summary.republished).toBe(1);
    expect(summary.failedDispatches).toBe(0);
    expect(await getDispatchByRunId(env.DB, runId)).toMatchObject({
      status: "PUBLISHED",
      attempt_count: 6,
    });
  });

  it("fails a run whose dispatch exhausted its attempts", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    await env.DB.prepare(
      `UPDATE execution_dispatches SET attempt_count = 6, available_at = ? WHERE run_id = ?`,
    )
      .bind(isoFromNow(-60_000), runId)
      .run();

    const summary = await runScheduledJobs(env);
    expect(summary.failedDispatches).toBe(1);

    const run = await getRunRow(env.DB, runId);
    expect(run?.status).toBe("FAILED");
    expect(run?.error_class).toBe("EXECUTION_INFRASTRUCTURE");
    expect(run?.error_json).toContain("DISPATCH_EXHAUSTED");

    const dispatch = await getDispatchByRunId(env.DB, runId);
    expect(dispatch?.status).toBe("FAILED");
  });

  it("fails a run that stayed queued beyond the dispatch timeout", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session });
    const stale = isoFromNow(-20 * 60 * 1000);
    await env.DB.batch([
      env.DB.prepare(`UPDATE runs SET created_at = ?, updated_at = ? WHERE id = ?`).bind(
        stale,
        stale,
        runId,
      ),
      env.DB.prepare(
        `UPDATE execution_dispatches SET status = 'CANCELLED', updated_at = ? WHERE run_id = ?`,
      ).bind(nowIso(), runId),
    ]);

    const summary = await runScheduledJobs(env);
    expect(summary.failedStaleRuns).toBe(1);

    const run = await getRunRow(env.DB, runId);
    expect(run?.status).toBe("FAILED");
    expect(run?.error_json).toContain("DISPATCH_TIMEOUT");
  });

  it("deletes expired runs and their dependent rows", async () => {
    const session = await createSession();
    const { runId } = await seedRun({ session, status: "FAILED" });
    await env.DB.prepare(`UPDATE runs SET expires_at = ? WHERE id = ?`)
      .bind(isoFromNow(-60_000), runId)
      .run();

    const summary = await runScheduledJobs(env);
    expect(summary.deletedRuns).toBe(1);

    expect(await getRunRow(env.DB, runId)).toBeNull();
    const steps = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM execution_steps WHERE run_id = ?`,
    )
      .bind(runId)
      .first<{ count: number }>();
    expect(Number(steps?.count)).toBe(0);
    const events = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM execution_events WHERE run_id = ?`,
    )
      .bind(runId)
      .first<{ count: number }>();
    expect(Number(events?.count)).toBe(0);
  });

  it("opens the sandbox circuit breaker after repeated infrastructure failures", async () => {
    const session = await createSession();
    for (let index = 0; index < 3; index += 1) {
      const { runId } = await seedRun({ session, status: "FAILED" });
      await env.DB.prepare(
        `UPDATE runs SET error_class = 'EXECUTION_INFRASTRUCTURE', completed_at = ?
          WHERE id = ?`,
      )
        .bind(nowIso(), runId)
        .run();
    }

    const summary = await runScheduledJobs(env);
    expect(summary.circuitOpened).toBe(true);

    const openUntil = await getFlag(env.DB, "sandbox_circuit_open_until");
    expect(openUntil).not.toBeNull();
    expect(Date.parse(openUntil!)).toBeGreaterThan(Date.now());

    const sandbox = await readSuccess<SandboxStatus>(await apiFetch("/api/sandbox", {}, session));
    expect(sandbox.enabled).toBe(false);
    expect(sandbox.circuitOpenUntil).toBe(openUntil);

    const rejected = await launchRun(session, {
      input: {
        title: "Circuit test",
        document: "This document is long enough to pass validation.",
      },
    });
    expect(rejected.response.status).toBe(503);
    expect((await readFailure(rejected.response)).code).toBe("SANDBOX_CIRCUIT_OPEN");
    expect(rejected.response.headers.get("retry-after")).not.toBeNull();
  });

  it("honours the global sandbox disable flag", async () => {
    const session = await createSession();
    await env.DB.prepare(
      `UPDATE system_flags SET value = 'false' WHERE key = 'sandbox_enabled'`,
    ).run();

    const rejected = await launchRun(session, {
      input: {
        title: "Disabled test",
        document: "This document is long enough to pass validation.",
      },
    });
    expect(rejected.response.status).toBe(503);
    expect((await readFailure(rejected.response)).code).toBe("SANDBOX_DISABLED");
  });
});
