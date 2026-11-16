import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { sameOriginMiddleware, type AppEnv } from "../../worker/api/middleware";
import { ApiError } from "../../worker/api/errors";

const publicOrigin = "https://traceyard.example.test";
function write(headers: Record<string, string>, configured: string | null = publicOrigin) {
  const app = new Hono<AppEnv>();
  app.use("*", sameOriginMiddleware());
  app.post("/connect", (c) => c.json({ connected: true }));
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ code: error.code }, error.status);
    throw error;
  });
  return app.fetch(new Request("http://localhost:5173/connect", { method: "POST", headers }), {
    PUBLIC_APP_ORIGIN: configured ?? undefined,
  } as Env);
}
describe("same-origin writes behind a reverse proxy", () => {
  it("accepts the exact public origin when the proxy forwards to local HTTP", async () => {
    expect((await write({ origin: publicOrigin, "sec-fetch-site": "same-origin" })).status).toBe(
      200,
    );
    expect((await write({ origin: publicOrigin }, publicOrigin + "/")).status).toBe(200);
  });
  it("preserves direct same-origin development and signed server requests", async () => {
    expect((await write({ origin: "http://localhost:5173" }, null)).status).toBe(200);
    expect((await write({ origin: publicOrigin }, null)).status).toBe(403);
    expect((await write({})).status).toBe(200);
  });
  it.each([
    "https://attacker.example.test",
    "https://traceyard.example.test.attacker.test",
    "http://traceyard.example.test",
    "https://traceyard.example.test:444",
    "null",
  ])("rejects the untrusted origin %s", async (origin) => {
    const response = await write({ origin, "sec-fetch-site": "same-origin" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CROSS_ORIGIN_REJECTED" });
  });
  it.each([
    "not-a-url",
    publicOrigin + "/another-app",
    publicOrigin + "?redirect=1",
    "https://user:password@traceyard.example.test",
    "http://traceyard.example.test",
  ])("does not trust invalid configuration %s", async (configured) => {
    expect((await write({ origin: publicOrigin }, configured)).status).toBe(403);
  });
  it("never uses attacker-controlled forwarding headers as an allowlist", async () => {
    expect(
      (
        await write({
          origin: "https://attacker.test",
          "x-forwarded-host": "attacker.test",
          "x-forwarded-proto": "https",
          forwarded: "host=attacker.test;proto=https",
        })
      ).status,
    ).toBe(403);
  });
  it.each(["cross-site", "same-site"])(
    "rejects %s browser writes even with a matching origin",
    async (site) => {
      expect((await write({ origin: publicOrigin, "sec-fetch-site": site })).status).toBe(403);
      expect((await write({ "sec-fetch-site": site })).status).toBe(403);
    },
  );
});
