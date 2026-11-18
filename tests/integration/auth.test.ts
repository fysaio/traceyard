import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { sha256Base64Url, sha256Hex } from "../../worker/lib/crypto";
import { endOfUtcDay } from "../../worker/lib/time";
import type { LaunchRunResult, RunDetail, RunListPage } from "../../shared/contracts/api";
import {
  apiFetch,
  apiFetchWithGitHub,
  createSession,
  launchBody,
  postJson,
  readFailure,
  readSuccess,
  type Session,
  ORIGIN,
} from "./helpers";

const PROFILE = {
  id: 7812345,
  login: "traceyard-developer",
  name: "Traceyard Developer",
  avatar_url: "https://avatars.githubusercontent.com/u/7812345",
};

function providerFetch(profile = PROFILE): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      expect(init?.method).toBe("POST");
      const request = JSON.parse(String(init?.body)) as {
        client_id: string;
        client_secret: string;
        code: string;
        redirect_uri: string;
        code_verifier: string;
      };
      expect(request.client_id).toBe("traceyard-test-client");
      expect(request.client_secret).toBe("test-only-not-a-github-secret");
      expect(request.code).toBe("valid-code");
      expect(request.redirect_uri).toBe(`${ORIGIN}/api/auth/github/callback`);
      expect(request.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      return Response.json({ access_token: "mock-provider-token", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mock-provider-token");
      return Response.json(profile);
    }
    throw new Error(`Unexpected GitHub endpoint ${url}`);
  };
}

function cookiePairs(response: Response): string[] {
  const header = response.headers.get("set-cookie") ?? "";
  return header
    .split(/,\s*(?=[^;,=]+=)/u)
    .map((cookie) => cookie.split(";", 1)[0]?.trim() ?? "")
    .filter((cookie) => cookie.length > 0);
}

function cookieValue(cookies: string[], name: string): string {
  const value = cookies.find((cookie) => cookie.startsWith(`${name}=`))?.slice(name.length + 1);
  if (value === undefined) throw new Error(`Cookie ${name} was not set.`);
  return value;
}

function authCookie(cookieHeader: string): string {
  const cookie = cookieHeader.split(/;\s*/u).find((part) => part.startsWith("ty_auth_session="));
  if (cookie === undefined) throw new Error("The auth session cookie is missing.");
  return cookie;
}

async function guestSession(cookieHeader: string): Promise<Session> {
  const token = cookieHeader
    .split(/;\s*/u)
    .find((part) => part.startsWith("ty_session="))
    ?.slice("ty_session=".length);
  if (token === undefined) throw new Error("The guest session cookie is missing.");
  return { token, cookie: `ty_session=${token}`, idHash: await sha256Hex(token) };
}

async function signIn(
  githubFetch: typeof fetch = providerFetch(),
): Promise<{ cookie: string; userId: string; sessionId: string }> {
  const start = await apiFetchWithGitHub("/api/auth/github/start", {}, githubFetch);
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location") ?? "");
  expect(authorize.origin).toBe("https://github.com");
  expect(authorize.pathname).toBe("/login/oauth/authorize");
  expect(authorize.searchParams.get("scope")).toBeNull();
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

  const initialCookies = cookiePairs(start);
  const guestCookie = initialCookies.find((cookie) => cookie.startsWith("ty_session="));
  const stateCookie = initialCookies.find((cookie) => cookie.startsWith("ty_oauth_state="));
  const verifierCookie = initialCookies.find((cookie) => cookie.startsWith("ty_oauth_pkce="));
  if (!stateCookie || !verifierCookie) throw new Error("OAuth state cookies were not set.");
  const state = cookieValue(initialCookies, "ty_oauth_state");
  const verifier = cookieValue(initialCookies, "ty_oauth_pkce");
  expect(authorize.searchParams.get("state")).toBe(state);
  expect(authorize.searchParams.get("code_challenge")).toBe(await sha256Base64Url(verifier));

  const callbackCookies = [guestCookie, stateCookie, verifierCookie].filter(
    (cookie): cookie is string => cookie !== undefined,
  );
  const callback = await apiFetchWithGitHub(
    `/api/auth/github/callback?code=valid-code&state=${encodeURIComponent(state)}`,
    {},
    githubFetch,
    callbackCookies.join("; "),
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(`${ORIGIN}/`);

  const authCookie = cookiePairs(callback).find((cookie) => cookie.startsWith("ty_auth_session="));
  if (authCookie === undefined) throw new Error("The auth session cookie was not set.");
  const cookie = [guestCookie, authCookie].filter((value) => value !== undefined).join("; ");
  const sessionResponse = await apiFetchWithGitHub("/api/auth/session", {}, githubFetch, cookie);
  const payload = (await sessionResponse.json()) as {
    data: {
      user: { id: string };
      currentSessionId: string;
    };
  };
  return {
    cookie,
    userId: payload.data.user.id,
    sessionId: payload.data.currentSessionId,
  };
}

describe("GitHub authentication", () => {
  it("uses state and PKCE, exchanges the code on the server, and creates a durable identity", async () => {
    const seenRequests: string[] = [];
    const githubFetch: typeof fetch = async (input, init) => {
      seenRequests.push(String(input));
      if (String(input) === "https://github.com/login/oauth/access_token") {
        const request = JSON.parse(String(init?.body)) as {
          client_id: string;
          client_secret: string;
          code: string;
          redirect_uri: string;
          code_verifier: string;
        };
        expect(request.client_id).toBe("traceyard-test-client");
        expect(request.client_secret).toBe("test-only-not-a-github-secret");
        expect(request.code).toBe("valid-code");
        expect(request.redirect_uri).toBe(`${ORIGIN}/api/auth/github/callback`);
        expect(request.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        return Response.json({ access_token: "mock-provider-token", token_type: "bearer" });
      }
      if (String(input) === "https://api.github.com/user") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mock-provider-token");
        return Response.json(PROFILE);
      }
      throw new Error(`Unexpected GitHub endpoint ${String(input)}`);
    };

    const signedIn = await signIn(githubFetch);
    const session = await apiFetchWithGitHub("/api/auth/session", {}, githubFetch, signedIn.cookie);
    const body = (await session.json()) as {
      data: {
        user: { id: string; login: string; name: string; avatarUrl: string };
        sessions: Array<{ id: string; current: boolean }>;
        githubSignInAvailable: boolean;
      };
    };
    expect(body.data.user).toEqual({
      id: signedIn.userId,
      login: PROFILE.login,
      name: PROFILE.name,
      avatarUrl: PROFILE.avatar_url,
    });
    expect(body.data.sessions).toContainEqual(
      expect.objectContaining({ id: signedIn.sessionId, current: true }),
    );
    expect(body.data.githubSignInAvailable).toBe(true);
    expect(seenRequests).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ]);

    const identity = await env.DB.prepare(
      `SELECT provider, provider_subject FROM identities WHERE user_id = ?`,
    )
      .bind(signedIn.userId)
      .first<{ provider: string; provider_subject: string }>();
    expect(identity).toEqual({ provider: "github", provider_subject: String(PROFILE.id) });

    const storedSession = await env.DB.prepare(
      `SELECT session_hash FROM user_sessions WHERE id = ?`,
    )
      .bind(signedIn.sessionId)
      .first<{ session_hash: string }>();
    const authToken = signedIn.cookie
      .split(/;\s*/u)
      .find((cookie) => cookie.startsWith("ty_auth_session="))
      ?.slice("ty_auth_session=".length);
    expect(authToken).toBeDefined();
    expect(storedSession?.session_hash).not.toBe(authToken);
    expect(storedSession?.session_hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects missing or mismatched OAuth state without contacting GitHub", async () => {
    let providerCalls = 0;
    const githubFetch: typeof fetch = async () => {
      providerCalls += 1;
      return Response.json({});
    };
    const response = await apiFetchWithGitHub(
      "/api/auth/github/callback?code=valid-code&state=wrong-state",
      {},
      githubFetch,
      "ty_oauth_state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; ty_oauth_pkce=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toContain("ty_oauth_state=");
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("INVALID_OAUTH_CALLBACK");
    expect(providerCalls).toBe(0);
  });

  it.each(["missing", "mismatch", "expired", "cancelled"] as const)(
    "returns browser %s callbacks to sign-in without exchanging or disclosing a code",
    async (scenario) => {
      const start = await apiFetchWithGitHub("/api/auth/github/start", {}, providerFetch());
      const cookies = cookiePairs(start);
      const state = cookieValue(cookies, "ty_oauth_state");
      if (scenario === "expired") {
        await env.DB.prepare("UPDATE github_oauth_states SET expires_at = ? WHERE state_hash = ?")
          .bind("2000-01-01T00:00:00.000Z", await sha256Hex(state))
          .run();
      }
      const query = new URLSearchParams({ code: "private-provider-code", state });
      if (scenario === "missing") query.delete("state");
      if (scenario === "mismatch") query.set("state", "wrong-state");
      if (scenario === "cancelled") query.set("error", "access_denied");
      let providerCalls = 0;
      const response = await apiFetchWithGitHub(
        "/api/auth/github/callback?" + query,
        { headers: { Accept: "text/html" } },
        async () => {
          providerCalls++;
          return Response.json({});
        },
        cookies.join("; "),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        scenario === "cancelled" ? "/?signIn=cancelled" : "/?signIn=retry",
      );
      expect(response.headers.get("set-cookie")).toContain("ty_oauth_state=; Path=/");
      expect(response.headers.get("set-cookie")).toContain("ty_oauth_pkce=; Path=/");
      expect(response.headers.get("set-cookie")).not.toContain("ty_auth_session=");
      expect(providerCalls).toBe(0);
    },
  );

  it("logout revokes the persistent application session immediately", async () => {
    const signedIn = await signIn();
    const logout = await apiFetchWithGitHub(
      "/api/auth/logout",
      { method: "POST" },
      providerFetch(),
      signedIn.cookie,
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("ty_auth_session=");

    const nextRequest = await apiFetchWithGitHub(
      "/api/auth/session",
      {},
      providerFetch(),
      signedIn.cookie,
    );
    const payload = (await nextRequest.json()) as { data: { user: null } };
    expect(payload.data.user).toBeNull();

    const session = await env.DB.prepare(`SELECT revoked_at FROM user_sessions WHERE id = ?`)
      .bind(signedIn.sessionId)
      .first<{ revoked_at: string | null }>();
    expect(session?.revoked_at).not.toBeNull();
  });

  it("only claims runs from the active guest cookie and moves them into the personal workspace", async () => {
    const signedIn = await signIn();
    const originalGuest = await guestSession(signedIn.cookie);
    const otherGuest = await createSession();
    const created = await launchGuestRun(originalGuest);

    const authCookieValue = authCookie(signedIn.cookie);
    const otherSessionClaim = await apiFetchWithGitHub(
      "/api/auth/claim",
      { method: "POST" },
      providerFetch(),
      `${otherGuest.cookie}; ${authCookieValue}`,
    );
    expect(await readSuccess<{ claimedRuns: number }>(otherSessionClaim)).toEqual({
      claimedRuns: 0,
    });

    const otherGuestRead = await apiFetch(`/api/runs/${created.run.id}`, {}, otherGuest);
    expect(otherGuestRead.status).toBe(404);

    const claimed = await apiFetchWithGitHub(
      "/api/auth/claim",
      { method: "POST" },
      providerFetch(),
      `${originalGuest.cookie}; ${authCookieValue}`,
    );
    expect(await readSuccess<{ claimedRuns: number }>(claimed)).toEqual({ claimedRuns: 1 });

    const claimedRun = await env.DB.prepare(
      `SELECT owner_user_id, project_id FROM runs WHERE id = ?`,
    )
      .bind(created.run.id)
      .first<{ owner_user_id: string | null; project_id: string }>();
    expect(claimedRun?.owner_user_id).toBe(signedIn.userId);

    const project = await env.DB.prepare(
      `SELECT id FROM projects WHERE id = ? AND owner_user_id = ?`,
    )
      .bind(claimedRun?.project_id, signedIn.userId)
      .first<{ id: string }>();
    expect(project?.id).toBe(claimedRun?.project_id);

    const claimAudit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events
        WHERE project_id = ? AND action = 'guest_runs.claimed'
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(claimedRun?.project_id)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(claimAudit?.metadata_json ?? "{}")).toEqual({ claimedRuns: 1 });

    const noLongerGuestOwned = await apiFetch(`/api/runs/${created.run.id}`, {}, originalGuest);
    expect(noLongerGuestOwned.status).toBe(404);
  });

  it("moves eligible sandbox work into the selected owned project only", async () => {
    const signedIn = await signIn();
    const guest = await guestSession(signedIn.cookie);
    const run = await launchGuestRun(guest);
    const cookie = `${guest.cookie}; ${authCookie(signedIn.cookie)}`;
    const invoke = (path: string, method = "GET", body?: unknown) =>
      apiFetchWithGitHub(
        path,
        {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        },
        providerFetch(),
        cookie,
      );
    expect(await readSuccess(await invoke("/api/auth/guest-work"))).toEqual({ executions: 1 });
    expect(
      (await invoke("/api/auth/claim", "POST", { projectId: "prj_other_account" })).status,
    ).toBe(404);
    const project = await readSuccess<{ id: string }>(
      await invoke("/api/projects", "POST", { name: "Claim destination" }),
    );
    expect(
      await readSuccess(await invoke("/api/auth/claim", "POST", { projectId: project.id })),
    ).toEqual({ claimedRuns: 1 });
    expect(await readSuccess(await invoke("/api/auth/guest-work"))).toEqual({ executions: 0 });
    expect(
      await env.DB.prepare("SELECT project_id FROM runs WHERE id=?").bind(run.run.id).first(),
    ).toEqual({ project_id: project.id });
  });

  it("keeps projects, saved definitions, and run history available on another authenticated device", async () => {
    const firstDevice = await signIn();
    const projectResponse = await apiFetchWithGitHub(
      "/api/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Recovery workflows" }),
      },
      providerFetch(),
      `${firstDevice.cookie}`,
    );
    expect(projectResponse.status).toBe(201);
    const project = await readSuccess<{ id: string }>(projectResponse);

    const savedResponse = await apiFetchWithGitHub(
      `/api/projects/${project.id}/workflows`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Invoice recovery",
          description: "A saved, non-executable workflow definition.",
          definition: { nodes: [{ id: "validate" }], edges: [] },
        }),
      },
      providerFetch(),
      `${firstDevice.cookie}`,
    );
    expect(savedResponse.status).toBe(201);
    const saved = await readSuccess<{ id: string; definition: unknown }>(savedResponse);
    expect(saved.definition).toEqual({ nodes: [{ id: "validate" }], edges: [] });

    const launchResponse = await apiFetchWithGitHub(
      "/api/runs",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "account-run-01" },
        body: JSON.stringify(launchBody({ projectId: project.id })),
      },
      providerFetch(),
      firstDevice.cookie,
    );
    const launched = await readSuccess<LaunchRunResult>(launchResponse);
    expect(launched.run.id).toBeTruthy();

    const secondDevice = await signIn();
    expect(secondDevice.userId).toBe(firstDevice.userId);
    const historyResponse = await apiFetchWithGitHub(
      "/api/runs",
      {},
      providerFetch(),
      secondDevice.cookie,
    );
    const history = await readSuccess<RunListPage>(historyResponse);
    expect(history.items.map((run) => run.id)).toContain(launched.run.id);

    const detailResponse = await apiFetchWithGitHub(
      `/api/runs/${launched.run.id}`,
      {},
      providerFetch(),
      secondDevice.cookie,
    );
    const detail = await readSuccess<RunDetail>(detailResponse);
    expect(detail.id).toBe(launched.run.id);

    const savedOnSecondDevice = await apiFetchWithGitHub(
      `/api/projects/${project.id}/workflows`,
      {},
      providerFetch(),
      secondDevice.cookie,
    );
    const savedList = await readSuccess<{ items: Array<{ id: string }> }>(savedOnSecondDevice);
    expect(savedList.items.map((workflow) => workflow.id)).toContain(saved.id);
  });

  it("denies cross-user and cross-project run and workflow requests", async () => {
    const owner = await signIn();
    const outsider = await signIn(
      providerFetch({
        ...PROFILE,
        id: PROFILE.id + 1,
        login: "different-developer",
      }),
    );
    const foreignSessionRevoke = await apiFetchWithGitHub(
      `/api/auth/sessions/${owner.sessionId}/revoke`,
      { method: "POST" },
      providerFetch(),
      outsider.cookie,
    );
    expect(foreignSessionRevoke.status).toBe(403);

    const ownerProject = await apiFetchWithGitHub(
      "/api/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Private project" }),
      },
      providerFetch(),
      owner.cookie,
    );
    const project = await readSuccess<{ id: string }>(ownerProject);
    const workflow = await apiFetchWithGitHub(
      `/api/projects/${project.id}/workflows`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Private", definition: { nodes: [], edges: [] } }),
      },
      providerFetch(),
      owner.cookie,
    );
    expect(workflow.status).toBe(201);

    const privateRunResponse = await apiFetchWithGitHub(
      "/api/runs",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "private-run-01" },
        body: JSON.stringify(launchBody({ projectId: project.id })),
      },
      providerFetch(),
      owner.cookie,
    );
    const privateRun = await readSuccess<LaunchRunResult>(privateRunResponse);

    const foreignRunRead = await apiFetchWithGitHub(
      `/api/runs/${privateRun.run.id}`,
      {},
      providerFetch(),
      outsider.cookie,
    );
    expect(foreignRunRead.status).toBe(404);

    const foreignProjectRun = await apiFetchWithGitHub(
      "/api/runs",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "foreign-run-01" },
        body: JSON.stringify(launchBody({ projectId: project.id })),
      },
      providerFetch(),
      outsider.cookie,
    );
    expect(foreignProjectRun.status).toBe(404);

    const foreignProject = await apiFetchWithGitHub(
      `/api/projects/${project.id}/workflows`,
      {},
      providerFetch(),
      outsider.cookie,
    );
    expect(foreignProject.status).toBe(404);
  });

  it("keeps the global daily sandbox budget shared by guests and signed-in accounts", async () => {
    const session = await createSession();
    const date = new Date();
    const day = date.toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO quota_counters (
         bucket_key, count, limit_value, window_start, expires_at, updated_at
       ) VALUES (?, 99, 100, ?, ?, ?)`,
    )
      .bind(`global:day:${day}`, `${day}T00:00:00.000Z`, endOfUtcDay(date), date.toISOString())
      .run();

    const guestRun = await launchGuestRun(session);
    expect(guestRun.response.status).toBe(202);

    const signedIn = await signIn();
    const response = await apiFetchWithGitHub(
      "/api/runs",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "account-run-02" },
        body: JSON.stringify(launchBody()),
      },
      providerFetch(),
      signedIn.cookie,
    );
    expect(response.status).toBe(429);
    const failure = await readFailure(response);
    expect(failure.code).toBe("GLOBAL_DAILY_QUOTA");
    expect(failure.message).toContain("global daily execution allowance");
    expect(response.headers.get("retry-after")).not.toBeNull();
  });
});

async function launchGuestRun(session: Session) {
  const response = await postJson("/api/runs", launchBody(), session);
  const result = await readSuccess<LaunchRunResult>(response);
  return { response, run: result.run };
}
