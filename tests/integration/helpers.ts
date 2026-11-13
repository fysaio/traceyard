import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";

import worker from "../../worker/index";
import { buildDispatchMessage } from "../../worker/queue/producer";

import type {
  ApiFailure,
  ApiSuccess,
  LaunchRunResult,
  RunDetail,
} from "../../shared/contracts/api";
import { DOCUMENT_WORKFLOW, type FailureScenario } from "../../shared/workflow/document";
import { randomId, sha256Hex } from "../../worker/lib/crypto";
import { isoFromNow, nowIso } from "../../worker/lib/time";
import { insertRunBundle } from "../../worker/persistence/run-creation";

export const ORIGIN = "https://traceyard.test";

export const VALID_INPUT = {
  title: "Quarterly Operations Review",
  document: [
    "Owner: Ada Lovelace",
    "Status: approved",
    "",
    "The operations team reviewed the quarter. Revenue grew steadily across all regions.",
    "Latency improved after the migration. The migration also reduced incident volume.",
    "Workflow reliability is now the main investment area.",
  ].join("\n"),
};

export interface Session {
  token: string;
  cookie: string;
  idHash: string;
}

export async function createSession(): Promise<Session> {
  const response = await apiFetch("/api/health");
  const token = /ty_session=([A-Za-z0-9_-]{43})/u.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  if (token === undefined) {
    throw new Error("The health endpoint did not issue a sandbox session cookie.");
  }
  return { token, cookie: `ty_session=${token}`, idHash: await sha256Hex(token) };
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  session?: Session,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("origin", ORIGIN);
  if (session !== undefined) headers.set("cookie", session.cookie);
  return SELF.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

export async function postJson(
  path: string,
  body: unknown,
  session: Session,
  headers: Record<string, string> = {},
): Promise<Response> {
  return apiFetch(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    session,
  );
}

export async function readSuccess<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as ApiSuccess<T> | ApiFailure;
  if (!("data" in payload)) {
    throw new Error(`Expected success, received ${JSON.stringify(payload)}`);
  }
  return payload.data;
}

export async function readFailure(response: Response): Promise<ApiFailure["error"]> {
  const payload = (await response.json()) as ApiSuccess<unknown> | ApiFailure;
  if ("data" in payload) {
    throw new Error(`Expected failure, received ${JSON.stringify(payload)}`);
  }
  return payload.error;
}

export function launchBody(
  overrides: Partial<{ workflowId: string; input: unknown; scenario: FailureScenario }> = {},
): { workflowId: string; input: unknown; scenario: FailureScenario } {
  return {
    workflowId: "document-intelligence",
    input: VALID_INPUT,
    scenario: "success",
    ...overrides,
  };
}

export interface SeededRun {
  runId: string;
  dispatchId: string;
}

/**
 * Writes a run through the same atomic bundle the API uses, but without
 * publishing to the queue. This creates deterministic QUEUED/FAILED fixtures
 * for workflows, cancellation and retry tests.
 */
export async function seedRun(options: {
  session: Session;
  status?: "QUEUED" | "FAILED";
  scenario?: FailureScenario;
  input?: unknown;
}): Promise<SeededRun> {
  const runId = randomId("run");
  const dispatchId = randomId("dsp");
  const createdAt = nowIso();
  const inputJson = JSON.stringify(options.input ?? VALID_INPUT);
  const scenario = options.scenario ?? "success";

  await insertRunBundle(env.DB, {
    run: {
      id: runId,
      projectId: "prj_sandbox",
      workflowId: DOCUMENT_WORKFLOW.id,
      workflowVersion: DOCUMENT_WORKFLOW.version,
      triggerSource: "sandbox",
      scenario,
      visibility: "private",
      ownerSessionHash: options.session.idHash,
      ownerIpHash: await sha256Hex("127.0.0.1"),
      parentRunId: null,
      retryOfRunId: null,
      idempotencyKey: null,
      inputHash: await sha256Hex(inputJson),
      inputJson,
      correlationId: randomId("cor"),
      createdAt,
      expiresAt: isoFromNow(24 * 60 * 60 * 1000),
    },
    steps: DOCUMENT_WORKFLOW.steps.map((step) => ({
      id: randomId("stp"),
      key: step.key,
      name: step.name,
      ordinal: step.ordinal,
      maxAttempts: step.retry.maxAttempts,
    })),
    dispatch: { id: dispatchId, availableAt: createdAt },
    idempotency: null,
    events: [
      {
        type: "run.created",
        level: "info",
        message: "Seeded run accepted and queued for execution.",
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
      projectId: "prj_sandbox",
      actorType: "anonymous",
      actorIdHash: options.session.idHash,
      action: "run.created",
      targetType: "run",
      targetId: runId,
      requestId: "test",
    },
    retryLink: null,
  });

  if (options.status === "FAILED") {
    const now = nowIso();
    await env.DB.prepare(
      `UPDATE runs
          SET status = 'FAILED', error_json = ?, error_class = 'PERMANENT_APPLICATION',
              completed_at = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(
        JSON.stringify({
          class: "PERMANENT_APPLICATION",
          code: "SEEDED_FAILURE",
          message: "Seeded failure for tests.",
          retryable: false,
        }),
        now,
        now,
        runId,
      )
      .run();
    await env.DB.prepare(
      `UPDATE execution_dispatches SET status = 'CLAIMED', claimed_at = ?, updated_at = ?
        WHERE run_id = ?`,
    )
      .bind(now, now, runId)
      .run();
  }

  return { runId, dispatchId };
}

export async function getRunDetail(session: Session, runId: string): Promise<RunDetail> {
  const response = await apiFetch(`/api/runs/${runId}`, {}, session);
  return readSuccess<RunDetail>(response);
}

export async function waitForRun(
  session: Session,
  runId: string,
  predicate: (detail: RunDetail) => boolean,
  timeoutMs = 20_000,
): Promise<RunDetail> {
  const deadline = Date.now() + timeoutMs;
  let latest: RunDetail | null = null;
  while (Date.now() < deadline) {
    const detail = await getRunDetail(session, runId);
    latest = detail;
    if (predicate(detail)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for run ${runId}: ${JSON.stringify(latest)}`);
}

export async function launchRun(
  session: Session,
  overrides: Parameters<typeof launchBody>[0] = {},
  idempotencyKey?: string,
): Promise<{ response: Response; result: LaunchRunResult | null }> {
  const response = await postJson(
    "/api/runs",
    launchBody(overrides),
    session,
    idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
  );
  if (!response.ok) return { response, result: null };
  return { response, result: await readSuccess<LaunchRunResult>(response) };
}

/**
 * Drives the real queue consumer with a synthetic batch. This exercises the
 * same claim-and-create path Cloudflare Queues uses at runtime.
 */
export async function deliverDispatch(
  runId: string,
  dispatchId: string,
  attempts = 1,
): Promise<Awaited<ReturnType<typeof getQueueResult>>> {
  const message = buildDispatchMessage(runId, dispatchId);
  const batch = createMessageBatch("traceyard-executions", [
    {
      id: `msg_${crypto.randomUUID()}`,
      timestamp: Date.now(),
      attempts,
      body: message,
    },
  ]);
  const context = createExecutionContext();
  await worker.queue(batch, env, context);
  return getQueueResult(batch, context);
}

export async function waitFor<T>(
  read: () => Promise<T | null | undefined>,
  predicate: (value: T) => boolean,
  timeoutMs = 20_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T | null | undefined = null;
  while (Date.now() < deadline) {
    latest = await read();
    if (latest !== null && latest !== undefined && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for condition: ${JSON.stringify(latest)}`);
}
