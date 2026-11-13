import { Hono } from "hono";

import {
  eventListQuerySchema,
  launchRunRequestSchema,
  runListQuerySchema,
} from "../../../shared/contracts/api";
import { decodeRunCursor } from "../../../shared/domain/cursor";
import { toEventView } from "../../persistence/mappers";
import {
  cancelRun,
  getRunDetailForSession,
  launchRun,
  listEventPage,
  listRunsForSession,
  retryRun,
} from "../../services/run-service";
import { badRequest } from "../errors";
import { getRequestContext, readJsonBody, type AppEnv } from "../middleware";
import { parseWith } from "../errors";

export const runRoutes = new Hono<AppEnv>();

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]{8,128}$/u;

function readIdempotencyKey(header: string | undefined): string | null {
  if (header === undefined || header.trim().length === 0) return null;
  const value = header.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw badRequest(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be 8-128 characters of letters, digits, dot, dash or underscore.",
    );
  }
  return value;
}

runRoutes.post("/runs", async (c) => {
  const { config, requestId } = getRequestContext(c);
  const session = c.get("session");
  const idempotencyKey = readIdempotencyKey(c.req.header("idempotency-key"));
  const body = parseWith(
    launchRunRequestSchema,
    await readJsonBody(c),
    "The launch request is invalid.",
  );

  const { result, status } = await launchRun(c.env, {
    session,
    requestId,
    body,
    idempotencyKey,
    config,
  });

  return c.json(
    {
      data: result,
      meta: { requestId, replayed: result.replayed },
    },
    status,
  );
});

runRoutes.get("/runs", async (c) => {
  const { requestId } = getRequestContext(c);
  const query = parseWith(
    runListQuerySchema,
    Object.fromEntries(new URL(c.req.url).searchParams),
    "The run list query is invalid.",
  );
  const cursor = query.cursor === undefined ? null : decodeRunCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null) {
    throw badRequest("INVALID_CURSOR", "The pagination cursor is not valid.");
  }
  const page = await listRunsForSession(c.env.DB, c.get("session").idHash, {
    status: query.status,
    workflowId: query.workflowId,
    cursor,
    limit: query.limit,
  });
  return c.json({ data: page, meta: { requestId } });
});

runRoutes.get("/runs/:id", async (c) => {
  const { requestId } = getRequestContext(c);
  const detail = await getRunDetailForSession(c.env.DB, c.req.param("id"), c.get("session").idHash);
  if (detail === null) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "The requested run was not found.",
          requestId,
        },
      },
      404,
    );
  }
  return c.json({ data: detail, meta: { requestId } });
});

runRoutes.get("/runs/:id/events", async (c) => {
  const { requestId } = getRequestContext(c);
  const query = parseWith(
    eventListQuerySchema,
    Object.fromEntries(new URL(c.req.url).searchParams),
    "The event query is invalid.",
  );
  const page = await listEventPage(
    c.env.DB,
    c.req.param("id"),
    c.get("session").idHash,
    query.after,
    query.limit,
  );
  return c.json(
    {
      data: { items: page.items.map(toEventView), nextCursor: page.nextCursor },
      meta: { requestId },
    },
    200,
  );
});

runRoutes.post("/runs/:id/cancel", async (c) => {
  const { requestId } = getRequestContext(c);
  const result = await cancelRun(c.env.DB, c.get("session").idHash, c.req.param("id"), requestId);
  return c.json({ data: result, meta: { requestId } }, 200);
});

runRoutes.post("/runs/:id/retry", async (c) => {
  const { config, requestId } = getRequestContext(c);
  const result = await retryRun(c.env, {
    session: c.get("session"),
    runId: c.req.param("id"),
    requestId,
    config,
  });
  return c.json({ data: result, meta: { requestId } }, 202);
});
