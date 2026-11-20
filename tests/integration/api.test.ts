import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { apiFetch, createSession, readFailure, readSuccess } from "./helpers";

describe("health and catalog", () => {
  it("reports database health without creating a sandbox session", async () => {
    const sessionCount = () =>
      env.DB.prepare("SELECT COUNT(*) AS count FROM sandbox_sessions").first<number>("count");
    const before = await sessionCount();
    const response = await apiFetch("/api/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/u);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await sessionCount()).toBe(before);

    const body = await readSuccess<{
      status: string;
      checks: { database: { status: string } };
    }>(response);
    expect(body.status).toBe("ok");
    expect(body.checks.database.status).toBe("ok");
  });
});

describe("write protection", () => {
  it("rejects cross-origin writes", async () => {
    const session = await createSession();
    const response = await apiFetch(
      "/api/projects",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ name: "Cross-origin" }),
      },
      session,
    );
    expect(response.status).toBe(403);
    expect((await readFailure(response)).code).toBe("CROSS_ORIGIN_REJECTED");
  });
});

describe("operational endpoints", () => {
  it("returns a safe 404 for an unknown API route", async () => {
    const response = await apiFetch("/api/does-not-exist");
    expect(response.status).toBe(404);
    expect((await readFailure(response)).code).toBe("NOT_FOUND");
  });
});
