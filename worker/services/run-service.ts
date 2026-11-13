import type {
  CancelRunResult,
  LaunchRunResult,
  RetryRunResult,
  RunDetail,
  RunListPage,
  RunSummary,
  StepCounts,
} from "../../shared/contracts/api";
import type { FailureScenario } from "../../shared/workflow/document";
import type { AppConfig } from "../config";
import { DomainError } from "../../shared/domain/errors";
import { encodeRunCursor } from "../../shared/domain/cursor";
import type { RunStatus } from "../../shared/domain/status";
import { dayKey, endOfUtcDay, hourKey, isoFromNow, nowIso, startOfUtcDay } from "../lib/time";
import { randomId, sha256Hex } from "../lib/crypto";
import { log, logError } from "../observability/logger";
import { appendAudit } from "../persistence/audit";
import { findWorkflowByIdOrSlug, SANDBOX_PROJECT_ID } from "../persistence/catalog";
import { getDispatchByRunId } from "../persistence/dispatches";
import { eventInsertStatement } from "../persistence/events";
import {
  emptyStepCounts,
  stepCountsFromRows,
  toRunDetail,
  toRunSummary,
} from "../persistence/mappers";
import {
  countActiveRuns,
  getAttempts,
  getEvents,
  getRunForOwner,
  getRunForSession,
  getStepStatusCounts,
  getSteps,
  listRuns,
} from "../persistence/runs";
import { insertRunBundle } from "../persistence/run-creation";
import { getFlag, releaseQuota, reserveQuota } from "../persistence/quotas";
import type { StepStatusCountRow } from "../persistence/rows";
import type { SandboxSession } from "../api/middleware";
import {
  ApiError,
  badRequest,
  conflict,
  notFound,
  serviceUnavailable,
  tooManyRequests,
} from "../api/errors";
import { publishDispatch } from "../queue/producer";
import { assertCatalogMatchesRuntime } from "../workflows/registry";

const DEDUPE_WINDOW_MS = 10_000;

export interface LaunchInput {
  workflowId: string;
  input: unknown;
  scenario: FailureScenario;
}

export async function launchRun(
  env: Env,
  options: {
    session: SandboxSession;
    requestId: string;
    body: LaunchInput;
    idempotencyKey: string | null;
    config: AppConfig;
  },
): Promise<{ result: LaunchRunResult; replayed: boolean; status: 200 | 202 }> {
  const { session, requestId, body, idempotencyKey, config } = options;
  const db = env.DB;

  const entry = await findWorkflowByIdOrSlug(db, body.workflowId);
  if (entry === null) {
    throw notFound("The requested workflow does not exist in this project.");
  }
  const runtime = assertCatalogMatchesRuntime(entry);

  let validatedInput: unknown;
  try {
    validatedInput = runtime.validateInput(body.input);
  } catch (error) {
    if (error instanceof DomainError) {
      throw badRequest(error.code, error.safeMessage);
    }
    throw error;
  }

  const inputJson = JSON.stringify(validatedInput);
  const inputHash = await sha256Hex(inputJson);
  const requestHash = await sha256Hex(
    JSON.stringify({
      workflow: entry.workflow.slug,
      version: entry.version.version,
      scenario: body.scenario,
      input: validatedInput,
    }),
  );

  if (idempotencyKey !== null) {
    const existing = await db
      .prepare(`SELECT request_hash, run_id FROM idempotency_records WHERE scope = ? AND key = ?`)
      .bind(session.idHash, idempotencyKey)
      .first<{ request_hash: string; run_id: string }>();
    if (existing !== null) {
      if (existing.request_hash !== requestHash) {
        throw new ApiError(
          422,
          "IDEMPOTENCY_KEY_REUSED",
          "This Idempotency-Key was already used with a different request body.",
        );
      }
      const detail = await getRunDetailForSession(db, existing.run_id, session.idHash);
      if (detail === null) {
        throw conflict(
          "IDEMPOTENCY_RECORD_UNAVAILABLE",
          "The original run is no longer available.",
        );
      }
      return {
        result: { run: detail, replayed: true, dispatch: detail.dispatch },
        replayed: true,
        status: 200,
      };
    }
  } else {
    const recent = await db
      .prepare(
        `SELECT id FROM runs
          WHERE project_id = ? AND owner_session_hash = ? AND workflow_id = ?
            AND input_hash = ? AND scenario = ? AND created_at >= ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(
        SANDBOX_PROJECT_ID,
        session.idHash,
        entry.workflow.id,
        inputHash,
        body.scenario,
        isoFromNow(-DEDUPE_WINDOW_MS),
      )
      .first<{ id: string }>();
    if (recent !== null) {
      const detail = await getRunDetailForSession(db, recent.id, session.idHash);
      if (detail !== null) {
        return {
          result: { run: detail, replayed: true, dispatch: detail.dispatch },
          replayed: true,
          status: 200,
        };
      }
    }
  }

  await assertSandboxAvailable(db, config, session.idHash, requestId);

  const activeRuns = await countActiveRuns(db, SANDBOX_PROJECT_ID);
  if (activeRuns >= config.sandbox.globalConcurrencyLimit) {
    await appendAudit(db, {
      projectId: SANDBOX_PROJECT_ID,
      actorType: "anonymous",
      actorIdHash: session.idHash,
      action: "sandbox.concurrency_rejected",
      targetType: "workflow",
      targetId: entry.workflow.id,
      metadata: { activeRuns, limit: config.sandbox.globalConcurrencyLimit },
      requestId,
    });
    throw tooManyRequests(
      "SANDBOX_CONCURRENCY_LIMIT",
      "The sandbox is running its maximum number of executions. Try again shortly.",
      5,
    );
  }

  const reservations = await reserveSandboxQuotas(db, session, config, requestId);
  const runId = randomId("run");
  const dispatchId = randomId("dsp");
  const correlationId = randomId("cor");
  const createdAt = nowIso();
  const expiresAt = isoFromNow(config.retentionDays * 24 * 60 * 60 * 1000);

  try {
    await insertRunBundle(db, {
      run: {
        id: runId,
        projectId: SANDBOX_PROJECT_ID,
        workflowId: entry.workflow.id,
        workflowVersion: entry.version.version,
        triggerSource: "sandbox",
        scenario: body.scenario,
        visibility: "private",
        ownerSessionHash: session.idHash,
        ownerIpHash: session.ipHash,
        parentRunId: null,
        retryOfRunId: null,
        idempotencyKey,
        inputHash,
        inputJson,
        correlationId,
        createdAt,
        expiresAt,
      },
      steps: runtime.steps.map((step) => ({
        id: randomId("stp"),
        key: step.key,
        name: step.name,
        ordinal: step.ordinal,
        maxAttempts: step.maxAttempts,
      })),
      dispatch: { id: dispatchId, availableAt: createdAt },
      idempotency:
        idempotencyKey === null
          ? null
          : {
              scope: session.idHash,
              key: idempotencyKey,
              requestHash,
              expiresAt: isoFromNow(24 * 60 * 60 * 1000),
            },
      events: [
        {
          type: "run.created",
          level: "info",
          message: "Run accepted and queued for execution.",
          data: {
            workflow: entry.workflow.slug,
            workflowVersion: entry.version.version,
            scenario: body.scenario,
          },
          dedupeKey: `${runId}:run.created`,
        },
        {
          type: "dispatch.pending",
          level: "info",
          message: "Dispatch record created; awaiting queue publication.",
          dedupeKey: `${runId}:dispatch.pending`,
        },
      ],
      audit: {
        projectId: SANDBOX_PROJECT_ID,
        actorType: "anonymous",
        actorIdHash: session.idHash,
        action: "run.created",
        targetType: "run",
        targetId: runId,
        metadata: {
          workflowId: entry.workflow.id,
          workflowVersion: entry.version.version,
          scenario: body.scenario,
        },
        requestId,
      },
      retryLink: null,
    });
  } catch (error) {
    await Promise.all(reservations.map((key) => releaseQuota(db, key)));
    if (idempotencyKey !== null && isUniqueIdempotencyConflict(error)) {
      const existing = await db
        .prepare(`SELECT request_hash, run_id FROM idempotency_records WHERE scope = ? AND key = ?`)
        .bind(session.idHash, idempotencyKey)
        .first<{ request_hash: string; run_id: string }>();
      if (existing !== null && existing.request_hash === requestHash) {
        const detail = await getRunDetailForSession(db, existing.run_id, session.idHash);
        if (detail !== null) {
          return {
            result: { run: detail, replayed: true, dispatch: detail.dispatch },
            replayed: true,
            status: 200,
          };
        }
      }
    }
    logError("run.create_failed", error, { requestId, runId });
    throw error;
  }

  const dispatch = await getDispatchByRunId(db, runId);
  if (dispatch !== null) {
    await publishDispatch(env, db, dispatch, requestId);
  }

  const detail = await getRunDetailForSession(db, runId, session.idHash);
  if (detail === null) {
    throw new Error("Run was persisted but could not be read back.");
  }

  log("info", "run.created", {
    requestId,
    runId,
    workflow: entry.workflow.slug,
    workflowVersion: entry.version.version,
    scenario: body.scenario,
    correlationId,
  });

  return {
    result: { run: detail, replayed: false, dispatch: detail.dispatch },
    replayed: false,
    status: 202,
  };
}

async function reserveSandboxQuotas(
  db: D1Database,
  session: SandboxSession,
  config: AppConfig,
  requestId: string,
): Promise<string[]> {
  const now = new Date();
  const day = dayKey(now);
  const hour = hourKey(now);
  const dayExpiry = endOfUtcDay(now);
  const hourExpiry = new Date(Date.parse(`${hour}:00:00.000Z`) + 2 * 60 * 60 * 1000).toISOString();
  const ipHourlyLimit = Math.max(12, config.sandbox.sessionHourlyLimit * 2);

  const buckets = [
    {
      key: `global:day:${day}`,
      limit: config.sandbox.dailyRunLimit,
      windowStart: startOfUtcDay(now).toISOString(),
      expiresAt: dayExpiry,
      reason: "GLOBAL_DAILY_QUOTA",
    },
    {
      key: `session:${session.idHash}:day:${day}`,
      limit: config.sandbox.sessionDailyLimit,
      windowStart: startOfUtcDay(now).toISOString(),
      expiresAt: dayExpiry,
      reason: "SESSION_DAILY_QUOTA",
    },
    {
      key: `session:${session.idHash}:hour:${hour}`,
      limit: config.sandbox.sessionHourlyLimit,
      windowStart: `${hour}:00:00.000Z`,
      expiresAt: hourExpiry,
      reason: "SESSION_HOURLY_QUOTA",
    },
    {
      key: `ip:${session.ipHash}:hour:${hour}`,
      limit: ipHourlyLimit,
      windowStart: `${hour}:00:00.000Z`,
      expiresAt: hourExpiry,
      reason: "IP_HOURLY_QUOTA",
    },
  ];

  const reserved: string[] = [];
  for (const bucket of buckets) {
    const outcome = await reserveQuota(db, {
      bucketKey: bucket.key,
      limit: bucket.limit,
      windowStart: bucket.windowStart,
      expiresAt: bucket.expiresAt,
    });
    if (!outcome.allowed) {
      await Promise.all(reserved.map((key) => releaseQuota(db, key)));
      await appendAudit(db, {
        projectId: SANDBOX_PROJECT_ID,
        actorType: "anonymous",
        actorIdHash: session.idHash,
        action: "sandbox.quota_rejected",
        targetType: "quota",
        targetId: bucket.key,
        metadata: { reason: bucket.reason, count: outcome.count, limit: bucket.limit },
        requestId,
      });
      throw tooManyRequests(
        "SANDBOX_QUOTA_EXCEEDED",
        "The sandbox execution quota has been reached. Try again later.",
        bucket.key.includes(":day:") ? 3600 : 600,
      );
    }
    reserved.push(bucket.key);
  }
  return reserved;
}

async function assertSandboxAvailable(
  db: D1Database,
  config: AppConfig,
  sessionHash: string,
  requestId: string,
): Promise<void> {
  const [enabled, circuitUntil] = await Promise.all([
    getFlag(db, "sandbox_enabled"),
    getFlag(db, "sandbox_circuit_open_until"),
  ]);

  if (enabled === "false") {
    await appendAudit(db, {
      projectId: SANDBOX_PROJECT_ID,
      actorType: "anonymous",
      actorIdHash: sessionHash,
      action: "sandbox.disabled_rejected",
      targetType: "sandbox",
      targetId: null,
      requestId,
    });
    throw serviceUnavailable(
      "SANDBOX_DISABLED",
      "Anonymous execution is temporarily disabled. Existing runs remain available.",
    );
  }

  if (circuitUntil !== null && Date.parse(circuitUntil) > Date.now()) {
    const retryAfter = Math.max(1, Math.ceil((Date.parse(circuitUntil) - Date.now()) / 1000));
    await appendAudit(db, {
      projectId: SANDBOX_PROJECT_ID,
      actorType: "anonymous",
      actorIdHash: sessionHash,
      action: "sandbox.circuit_rejected",
      targetType: "sandbox",
      targetId: null,
      metadata: { circuitUntil },
      requestId,
    });
    throw serviceUnavailable(
      "SANDBOX_CIRCUIT_OPEN",
      "Anonymous execution is paused after elevated infrastructure failures. Try again shortly.",
      retryAfter,
    );
  }

  void config;
}

export async function getRunDetailForSession(
  db: D1Database,
  runId: string,
  sessionHash: string,
): Promise<RunDetail | null> {
  const run = await getRunForSession(db, runId, SANDBOX_PROJECT_ID, sessionHash);
  if (run === null) return null;
  const [steps, attempts, dispatch, counts] = await Promise.all([
    getSteps(db, run.id),
    getAttempts(db, run.id),
    getDispatchByRunId(db, run.id),
    getStepStatusCounts(db, [run.id]),
  ]);
  return toRunDetail(run, stepCountsFromRows(counts), steps, attempts, dispatch);
}

export async function listRunsForSession(
  db: D1Database,
  sessionHash: string,
  options: {
    status?: RunStatus | undefined;
    workflowId?: string | undefined;
    cursor: { createdAt: string; id: string } | null;
    limit: number;
  },
): Promise<RunListPage> {
  const rows = await listRuns(db, {
    projectId: SANDBOX_PROJECT_ID,
    sessionHash,
    status: options.status,
    workflowId: options.workflowId,
    cursor: options.cursor,
    limit: options.limit + 1,
  });
  const hasMore = rows.length > options.limit;
  const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
  const counts = await getStepStatusCounts(
    db,
    pageRows.map((row) => row.id),
  );
  const countsByRun = groupCounts(counts);
  const items: RunSummary[] = pageRows.map((row) =>
    toRunSummary(row, countsByRun.get(row.id) ?? emptyStepCounts()),
  );
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last !== undefined
        ? encodeRunCursor({ createdAt: last.created_at, id: last.id })
        : null,
  };
}

export async function listEventPage(
  db: D1Database,
  runId: string,
  sessionHash: string,
  after: number,
  limit: number,
) {
  const run = await getRunForSession(db, runId, SANDBOX_PROJECT_ID, sessionHash);
  if (run === null) throw notFound("The requested run was not found.");
  const rows = await getEvents(db, runId, after, limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows,
    nextCursor: hasMore && last !== undefined ? last.seq : null,
  };
}

function groupCounts(rows: StepStatusCountRow[]): Map<string, StepCounts> {
  const byRun = new Map<string, StepStatusCountRow[]>();
  for (const row of rows) {
    const list = byRun.get(row.run_id) ?? [];
    list.push(row);
    byRun.set(row.run_id, list);
  }
  const result = new Map<string, StepCounts>();
  for (const [runId, runRows] of byRun) {
    result.set(runId, stepCountsFromRows(runRows));
  }
  return result;
}

export async function cancelRun(
  db: D1Database,
  sessionHash: string,
  runId: string,
  requestId: string,
): Promise<CancelRunResult> {
  let run = await getRunForOwner(db, runId, sessionHash);
  if (run === null) throw notFound("The requested run was not found.");

  if (run.status === "QUEUED") {
    const now = nowIso();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE runs SET status = 'CANCELLED', cancel_requested_at = ?, completed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'QUEUED'`,
        )
        .bind(now, now, now, run.id),
      db
        .prepare(
          `UPDATE execution_steps SET status = 'SKIPPED', completed_at = ?, updated_at = ?
            WHERE run_id = ? AND status = 'PENDING'`,
        )
        .bind(now, now, run.id),
      db
        .prepare(
          `UPDATE execution_dispatches SET status = 'CANCELLED', updated_at = ?
            WHERE run_id = ? AND status IN ('PENDING', 'PUBLISHED')`,
        )
        .bind(now, run.id),
      eventInsertStatement(db, {
        runId: run.id,
        type: "run.cancelled",
        level: "warn",
        message: "Run cancelled before execution started.",
        dedupeKey: `${run.id}:run.cancelled`,
        createdAt: now,
      }),
    ]);

    if ((results[0]?.meta.changes ?? 0) === 1) {
      await appendAudit(db, {
        projectId: SANDBOX_PROJECT_ID,
        actorType: "anonymous",
        actorIdHash: sessionHash,
        action: "run.cancelled",
        targetType: "run",
        targetId: run.id,
        metadata: { from: "QUEUED" },
        requestId,
      });
      return {
        runId: run.id,
        status: "CANCELLED",
        accepted: true,
        message: "Run cancelled before execution started.",
      };
    }

    run = (await getRunForOwner(db, runId, sessionHash)) ?? run;
  }

  if (run.status === "RUNNING") {
    const now = nowIso();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE runs SET status = 'CANCELLING', cancel_requested_at = ?, updated_at = ?
            WHERE id = ? AND status = 'RUNNING'`,
        )
        .bind(now, now, run.id),
      eventInsertStatement(db, {
        runId: run.id,
        type: "run.cancel.requested",
        level: "warn",
        message: "Cancellation requested. The engine will stop at the next checkpoint.",
        dedupeKey: `${run.id}:run.cancel.requested`,
        createdAt: now,
      }),
    ]);

    if ((results[0]?.meta.changes ?? 0) === 1) {
      await appendAudit(db, {
        projectId: SANDBOX_PROJECT_ID,
        actorType: "anonymous",
        actorIdHash: sessionHash,
        action: "run.cancel_requested",
        targetType: "run",
        targetId: run.id,
        requestId,
      });
      return {
        runId: run.id,
        status: "CANCELLING",
        accepted: true,
        message: "Cancellation requested. The run will stop at the next checkpoint.",
      };
    }

    run = (await getRunForOwner(db, runId, sessionHash)) ?? run;
  }

  if (run.status === "CANCELLING" || run.status === "CANCELLED") {
    return {
      runId: run.id,
      status: run.status,
      accepted: true,
      message:
        run.status === "CANCELLING"
          ? "Cancellation was already requested and is in progress."
          : "The run is already cancelled.",
    };
  }

  throw conflict("RUN_ALREADY_TERMINAL", `A run in status ${run.status} cannot be cancelled.`);
}

export async function retryRun(
  env: Env,
  options: {
    session: SandboxSession;
    runId: string;
    requestId: string;
    config: AppConfig;
  },
): Promise<RetryRunResult> {
  const db = env.DB;
  const { session, runId, requestId, config } = options;
  const original = await getRunForOwner(db, runId, session.idHash);
  if (original === null) throw notFound("The requested run was not found.");
  if (original.status !== "FAILED") {
    throw conflict("RUN_NOT_RETRYABLE", "Only failed runs can be retried.");
  }

  const existingRetry = await db
    .prepare(`SELECT id, retry_run_id FROM runs WHERE retry_of_run_id = ?`)
    .bind(original.id)
    .first<{ id: string; retry_run_id: string | null }>();
  if (original.retry_run_id !== null || existingRetry !== null) {
    throw conflict("RETRY_ALREADY_EXISTS", "A retry run already exists for this execution.");
  }

  const workflow = await db
    .prepare(`SELECT slug, name FROM workflows WHERE id = ?`)
    .bind(original.workflow_id)
    .first<{ slug: string; name: string }>();
  if (workflow === null) throw notFound("The workflow for this run no longer exists.");
  const entry = await findWorkflowByIdOrSlug(db, workflow.slug);
  if (entry === null) throw notFound("The workflow for this run no longer exists.");
  const runtime = assertCatalogMatchesRuntime(entry);
  if (entry.version.version !== original.workflow_version) {
    throw conflict(
      "RETRY_VERSION_UNAVAILABLE",
      "The workflow version used by this run is no longer available for retry.",
    );
  }

  await assertSandboxAvailable(db, config, session.idHash, requestId);
  const reservations = await reserveSandboxQuotas(db, session, config, requestId);

  const newRunId = randomId("run");
  const dispatchId = randomId("dsp");
  const correlationId = randomId("cor");
  const createdAt = nowIso();

  try {
    await insertRunBundle(db, {
      run: {
        id: newRunId,
        projectId: SANDBOX_PROJECT_ID,
        workflowId: original.workflow_id,
        workflowVersion: original.workflow_version,
        triggerSource: "retry",
        scenario: original.scenario,
        visibility: "private",
        ownerSessionHash: session.idHash,
        ownerIpHash: session.ipHash,
        parentRunId: original.id,
        retryOfRunId: original.id,
        idempotencyKey: null,
        inputHash: original.input_hash,
        inputJson: original.input_json,
        correlationId,
        createdAt,
        expiresAt: isoFromNow(config.retentionDays * 24 * 60 * 60 * 1000),
      },
      steps: runtime.steps.map((step) => ({
        id: randomId("stp"),
        key: step.key,
        name: step.name,
        ordinal: step.ordinal,
        maxAttempts: step.maxAttempts,
      })),
      dispatch: { id: dispatchId, availableAt: createdAt },
      idempotency: null,
      events: [
        {
          type: "run.created",
          level: "info",
          message: "Retry run accepted and queued for execution.",
          data: {
            workflow: entry.workflow.slug,
            workflowVersion: entry.version.version,
            scenario: original.scenario,
            retryOfRunId: original.id,
          },
          dedupeKey: `${newRunId}:run.created`,
        },
        {
          type: "dispatch.pending",
          level: "info",
          message: "Dispatch record created; awaiting queue publication.",
          dedupeKey: `${newRunId}:dispatch.pending`,
        },
      ],
      audit: {
        projectId: SANDBOX_PROJECT_ID,
        actorType: "anonymous",
        actorIdHash: session.idHash,
        action: "run.retried",
        targetType: "run",
        targetId: newRunId,
        metadata: { originalRunId: original.id },
        requestId,
      },
      retryLink: { originalRunId: original.id },
    });
  } catch (error) {
    await Promise.all(reservations.map((key) => releaseQuota(db, key)));
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: runs\.retry_of_run_id/u.test(error.message)
    ) {
      throw conflict("RETRY_ALREADY_EXISTS", "A retry run already exists for this execution.");
    }
    logError("run.retry_failed", error, { requestId, runId: original.id });
    throw error;
  }

  const dispatch = await getDispatchByRunId(db, newRunId);
  if (dispatch !== null) await publishDispatch(env, db, dispatch, requestId);

  const detail = await getRunDetailForSession(db, newRunId, session.idHash);
  if (detail === null) throw new Error("Retry run could not be read back.");
  return { originalRunId: original.id, run: detail, dispatch: detail.dispatch };
}

function isUniqueIdempotencyConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: idempotency_records\.scope, idempotency_records\.key/u.test(
      error.message,
    )
  );
}
