import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { createSession, apiFetchWithGitHub, ORIGIN, readSuccess } from "./helpers";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
async function account(id = 301) {
  const user = await getOrCreateGitHubIdentity(env.DB, {
      id,
      login: "experience-" + id,
      name: "Experience account",
      avatarUrl: null,
    }),
    auth = await createUserSession(env.DB, user.id, new Request(ORIGIN));
  return {
    projectId: (await getDefaultProjectId(env.DB, user.id))!,
    cookie: (await createSession()).cookie + "; ty_auth_session=" + auth.token,
  };
}
const external: typeof fetch = async () => {
  throw Error("Unexpected external GitHub call");
};
function call(a: { cookie: string }, path: string, method = "GET", body?: unknown, token?: string) {
  return apiFetchWithGitHub(
    path,
    {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: "Bearer " + token } : {}),
        "idempotency-key": "experience-launch-001",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    external,
    a.cookie,
  );
}
describe("Project and workflow product journeys", () => {
  it("lists actual projects, creates and renames one, and protects another account", async () => {
    const a = await account(),
      b = await account(302),
      first = await readSuccess<{ items: { id: string; name: string }[] }>(
        await call(a, "/api/projects"),
      );
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.name).toBe("Main project");
    const p = await readSuccess<{ id: string }>(
      await call(a, "/api/projects", "POST", { name: "Staging" }),
    );
    expect((await call(b, "/api/projects/" + p.id, "PATCH", { name: "Takeover" })).status).toBe(
      404,
    );
    expect((await call(a, "/api/projects/" + p.id, "PATCH", { name: " " })).status).toBe(400);
    expect(
      (await call(a, "/api/projects/" + p.id, "PATCH", { name: "Customer support" })).status,
    ).toBe(200);
    const later = await readSuccess<{ items: { id: string; name: string }[] }>(
      await call(a, "/api/projects"),
    );
    expect(later.items.map((p) => p.name)).toEqual(["Main project", "Customer support"]);
    expect(
      (await readSuccess<{ items: unknown[] }>(await call(b, "/api/projects"))).items,
    ).toHaveLength(1);
  });
  it("confirms connection only after an actual authorized trace is received", async () => {
    const a = await account(),
      b = await account(302),
      base = "/api/projects/" + a.projectId;
    const before = await readSuccess<{ lastTraceReceivedAt: string | null; activeKeys: number }>(
      await call(a, base + "/connection-status"),
    );
    expect(before.lastTraceReceivedAt).toBeNull();
    const key = await readSuccess<{ token: string }>(
      await call(a, base + "/keys", "POST", { name: "My server", scopes: ["traces:write"] }),
    );
    const keyOnly = await readSuccess<{ lastTraceReceivedAt: string | null; activeKeys: number }>(
      await call(a, base + "/connection-status"),
    );
    expect(keyOnly.activeKeys).toBe(1);
    expect(keyOnly.lastTraceReceivedAt).toBeNull();
    const now = new Date().toISOString();
    expect(
      (
        await call(
          a,
          "/api/v1/traces",
          "POST",
          {
            spans: [
              {
                traceId: "1".repeat(32),
                spanId: "2".repeat(16),
                name: "First connection",
                kind: "workflow",
                status: "SUCCEEDED",
                startedAt: now,
                endedAt: now,
                attributes: { service: "My server" },
              },
            ],
          },
          key.token,
        )
      ).status,
    ).toBe(202);
    const received = await readSuccess<{ lastTraceReceivedAt: string | null; traces: number }>(
      await call(a, base + "/connection-status"),
    );
    expect(received.lastTraceReceivedAt).not.toBeNull();
    expect(received.traces).toBe(1);
    const observed = await readSuccess<{
      items: { name: string; service: string; execution_count: number }[];
    }>(await call(a, base + "/instrumented-workflows"));
    expect(observed.items[0]).toMatchObject({
      name: "First connection",
      service: "My server",
      execution_count: 1,
    });
    expect((await call(b, base + "/connection-status")).status).toBe(404);
    expect(
      (
        await readSuccess<{ traces: number }>(
          await call(b, "/api/projects/" + b.projectId + "/connection-status"),
        )
      ).traces,
    ).toBe(0);
  });
});
