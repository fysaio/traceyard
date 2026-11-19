import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { sha256Base64Url, sha256Hex } from "../../worker/lib/crypto";
import { apiFetchWithGitHub, ORIGIN } from "./helpers";

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
});
