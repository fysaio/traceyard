import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError } from "../../src/lib/api";

afterEach(() => vi.unstubAllGlobals());
const response = (data: unknown) => Response.json({ data, meta: { requestId: "test" } });
describe("connected frontend transport", () => {
  it("uses server authentication and does not substitute a local identity", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response({
        user: null,
        currentSessionId: null,
        githubSignInAvailable: false,
        sessions: [],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect((await api.authSession()).user).toBeNull();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });
  it("surfaces an expired session rather than treating denial as empty data", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in again." } },
            { status: 401 },
          ),
        ),
    );
    await expect(api.projects()).rejects.toMatchObject({
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
  });
  it("rejects static hosting HTML returned in place of an API response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html><h1>App</h1>")));
    await expect(api.projects()).rejects.toBeInstanceOf(ApiClientError);
  });
});
