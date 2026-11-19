import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { createApp } from "../../worker/api/app";
import { createUserSession, getOrCreateGitHubIdentity } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import { createSession, ORIGIN, readSuccess } from "./helpers";
import { sha256Hex } from "../../worker/lib/crypto";
import { nowIso } from "../../worker/lib/time";
async function account(id = 1) {
  const user = await getOrCreateGitHubIdentity(env.DB, {
      id,
      login: "owner-" + id,
      name: null,
      avatarUrl: null,
    }),
    session = await createUserSession(env.DB, user.id, new Request(ORIGIN));
  return {
    user,
    projectId: (await getDefaultProjectId(env.DB, user.id))!,
    cookie: (await createSession()).cookie + "; ty_auth_session=" + session.token,
  };
}
function call(
  a: { cookie: string } | null,
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
) {
  return createApp().fetch(
    new Request(ORIGIN + path, {
      method,
      headers: {
        origin: ORIGIN,
        ...(a ? { cookie: a.cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: "Bearer " + token } : {}),
        "idempotency-key": "integration-key-00001",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    createExecutionContext(),
  );
}
async function key(a: Awaited<ReturnType<typeof account>>, scopes = ["traces:write"]) {
  return readSuccess<{ id: string; token: string }>(
    await call(a, `/api/projects/${a.projectId}/keys`, "POST", { name: "Server", scopes }),
  );
}
const span = {
  traceId: "a".repeat(32),
  spanId: "1".repeat(16),
  name: "Root",
  status: "RUNNING",
  startedAt: nowIso(),
  attributes: { authorization: "secret", label: "Bearer test-secret", nested: { apiKey: "value" } },
};
describe("Scoped integrations", () => {
  it("hashes one-time keys, denies other owners and enforces scopes/revocation", async () => {
    const a = await account(),
      b = await account(2),
      k = await key(a);
    const row = await env.DB.prepare("SELECT token_hash FROM api_keys WHERE id=?")
      .bind(k.id)
      .first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await sha256Hex(k.token));
    const listed = await call(a, `/api/projects/${a.projectId}/keys`);
    expect(await listed.text()).not.toContain(k.token);
    expect((await call(b, `/api/projects/${a.projectId}/keys`)).status).toBe(404);
    expect((await call(null, "/api/v1/traces", "POST", { spans: [span] }, k.token)).status).toBe(
      202,
    );
    await call(a, `/api/projects/${a.projectId}/keys/${k.id}/revoke`, "POST");
    expect((await call(null, "/api/v1/traces", "POST", { spans: [span] }, k.token)).status).toBe(
      401,
    );
  });
  it("redacts nested attributes, completes spans once and rejects parent cycles", async () => {
    const a = await account(),
      k = await key(a);
    await call(null, "/api/v1/traces", "POST", { spans: [span] }, k.token);
    await call(
      null,
      "/api/v1/traces",
      "POST",
      {
        spans: [
          {
            ...span,
            status: "SUCCEEDED",
            endedAt: nowIso(),
            output: { password: "hidden", result: 4 },
          },
        ],
      },
      k.token,
    );
    await call(
      null,
      "/api/v1/traces",
      "POST",
      { spans: [{ ...span, status: "FAILED", endedAt: nowIso(), output: "overwrite" }] },
      k.token,
    );
    const d = await readSuccess<{
      items: { attributes_json: string; output_json: string; status: string }[];
    }>(await call(a, `/api/projects/${a.projectId}/traces/${span.traceId}`));
    expect(d.items[0]!.status).toBe("SUCCEEDED");
    expect(JSON.parse(d.items[0]!.output_json)).toEqual({ password: "[redacted]", result: 4 });
    expect(d.items[0]!.attributes_json).not.toContain("test-secret");
    const cycle = { ...span, traceId: "b".repeat(32), parentSpanId: "2".repeat(16) };
    await call(null, "/api/v1/traces", "POST", { spans: [cycle] }, k.token);
    expect(
      (
        await call(
          null,
          "/api/v1/traces",
          "POST",
          { spans: [{ ...cycle, spanId: "2".repeat(16), parentSpanId: span.spanId }] },
          k.token,
        )
      ).status,
    ).toBe(409);
  });
});
