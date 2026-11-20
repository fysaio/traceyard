import { SELF, createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";

import type { ApiFailure, ApiSuccess } from "../../shared/contracts/api";
import { sha256Hex } from "../../worker/lib/crypto";
import { createApp } from "../../worker/api/app";

export const ORIGIN = "https://traceyard.test";

export interface Session {
  token: string;
  cookie: string;
  idHash: string;
}

export async function createSession(): Promise<Session> {
  const response = await apiFetch("/api/auth/session");
  const token = /ty_session=([A-Za-z0-9_-]{43})/u.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  if (token === undefined) {
    throw new Error("The session endpoint did not issue a sandbox session cookie.");
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

export async function apiFetchWithGitHub(
  path: string,
  init: RequestInit,
  githubFetch: typeof fetch,
  cookie?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("origin", ORIGIN);
  if (cookie !== undefined) headers.set("cookie", cookie);
  const request = new Request(`${ORIGIN}${path}`, { ...init, headers });
  return createApp({ githubFetch }).fetch(request, env, createExecutionContext());
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
