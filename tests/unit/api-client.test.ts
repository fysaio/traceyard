import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError, readAllEvents } from "../../src/lib/api";

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
  it("carries the project and a stable idempotency key when launching", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () =>
        response({ run: { id: "run_one" }, replayed: false, dispatch: { status: "PENDING" } }),
      );
    vi.stubGlobal("fetch", fetcher);
    const input = {
      workflowId: "wf_document_intelligence",
      projectId: "prj_owned",
      input: { title: "Review", document: "A document with enough content for validation." },
      scenario: "success" as const,
    };
    await api.launch(input, "stable-launch-key");
    await api.launch(input, "stable-launch-key");
    for (const [, init] of fetcher.mock.calls) {
      expect(init.credentials).toBe("same-origin");
      expect(init.headers["Idempotency-Key"]).toBe("stable-launch-key");
      expect(JSON.parse(init.body)).toEqual(input);
    }
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
    await expect(api.workflows()).rejects.toBeInstanceOf(ApiClientError);
  });
});

it("collects every persisted event page for the inspector and export", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ items: [{ id: "event-1", seq: 1 }], nextCursor: 1 }))
    .mockResolvedValueOnce(response({ items: [{ id: "event-2", seq: 2 }], nextCursor: null }));
  vi.stubGlobal("fetch", fetcher);
  const events = await readAllEvents("run_one");
  expect(events.items.map((event) => event.id)).toEqual(["event-1", "event-2"]);
  expect(fetcher.mock.calls[1]?.[0]).toContain("after=1");
});
