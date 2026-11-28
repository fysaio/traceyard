/** LOCAL ACCEPTANCE ENTRYPOINT ONLY. Not imported by worker/index.ts or the production config. */
import worker from "../../worker/index";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { authSessionCookie } from "../../worker/lib/cookie";
export { RepositoryDiscoveryWorkflow } from "../../worker/repositories/workflow";

const issue30Snapshot = {
  repository: "example/app",
  commit: "a".repeat(40),
  filesScanned: 4,
  warnings: [],
};
const issue30Execution = {
  status: "FAILED",
  commit: issue30Snapshot.commit,
  command: { directory: ".", script: "test", testPath: "tests/checkout.test.ts" },
  counts: { passed: 4, failed: 1, skipped: 0 },
  durationMs: 1200,
  exitCode: 1,
  failures: [
    {
      file: "tests/checkout.test.ts",
      name: "checkout retries",
      message: "Expected 42, received 41",
    },
  ],
};
const issue30Investigation = {
  id: "inv_browser",
  projectId: "prj_browser",
  question: "Why does checkout retry fail?",
  status: "EVIDENCE_READY",
  snapshot: issue30Snapshot,
  finding: {
    summary: "The retained checkout assertion failed.",
    basis: "observed",
    limitations: ["Only the selected test executed."],
    nextAction: "Repair the relevant code and verify the candidate.",
  },
  evidence: [
    {
      id: "evd_browser",
      kind: "diagnostic",
      basis: "observed",
      title: "Focused test execution",
      truncated: false,
    },
  ],
  attempts: [
    {
      id: "iat_browser",
      requestId: "req_browser",
      status: "FAILED",
      checkId: null,
      createdAt: "2026-11-18",
    },
  ],
  recordings: [],
  execution: issue30Execution,
  browserPath: "/investigations/inv_browser?project=prj_browser",
  budget: { outputChars: 3000, returnedChars: 1000, truncated: false },
};
const issue30Json = (data: unknown, status = 200) =>
  Response.json({ data, meta: { requestId: "issue-30-native-browser" } }, { status });

async function issue30ApiFixture(request: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/api/auth/session" && request.method === "GET")
    return issue30Json({
      user: { id: "usr_browser", login: "browser", name: "Browser", avatarUrl: null },
      sessions: [],
      githubSignInAvailable: true,
    });
  if (path === "/api/projects" && request.method === "GET")
    return issue30Json({
      items: [{ id: "prj_browser", name: "Browser", repository: "example/app" }],
    });
  if (path === "/api/projects/prj_browser/catalog" && request.method === "GET")
    return issue30Json({ executionAvailable: true, executionProvider: "github" });
  if (path === "/api/projects/prj_browser/repository/setup" && request.method === "GET")
    return issue30Json({ state: "READY" });
  if (path === "/api/projects/prj_browser/repository/index" && request.method === "GET")
    return issue30Json(null);
  if (path === "/api/projects/prj_browser/investigations" && request.method === "GET")
    return issue30Json({ items: [] });
  if (path === "/api/projects/prj_browser/investigations" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      body?.testPath !== issue30Execution.command.testPath ||
      body.commit !== issue30Snapshot.commit ||
      body.mode !== "execute"
    )
      return issue30Json({ error: "Unexpected synthetic issue #30 investigation request." }, 400);
    return issue30Json(issue30Investigation, 201);
  }
  if (path === "/api/projects/prj_browser/investigations/inv_browser" && request.method === "GET")
    return issue30Json(issue30Investigation);
  if (
    path === "/api/projects/prj_browser/investigations/inv_browser/evidence/evd_browser" &&
    request.method === "GET"
  )
    return issue30Json({
      id: "evd_browser",
      text: "Expected 42, received 41",
      offset: 0,
      nextOffset: null,
      truncated: false,
    });
  if (
    path === "/api/projects/prj_browser/investigations/inv_browser/verify" &&
    request.method === "POST"
  ) {
    const body = (await request.json().catch(() => null)) as { commit?: unknown } | null;
    if (body?.commit !== "b".repeat(40))
      return issue30Json({ error: "Unexpected synthetic candidate commit." }, 400);
    return issue30Json({
      id: "ver_browser",
      baselineId: issue30Investigation.id,
      candidateId: "inv_candidate",
      candidateCommit: body.commit,
      verdict: "PENDING",
      label: "Queued",
      baselineRun: null,
      candidateRun: null,
      changedTests: [],
      limitations: [],
      summary: "Checking candidate.",
      metrics: {},
    });
  }
  return null;
}

declare global {
  interface Env {
    LOCAL_ACCEPTANCE?: string;
  }
}
export default {
  ...worker,
  async fetch(request: Parameters<typeof worker.fetch>[0], env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/__acceptance/issue30" && env.LOCAL_ACCEPTANCE === "true") {
      if (request.method === "GET")
        return new Response(
          '<!doctype html><title>Issue 30 local browser fixture</title><main><h1>Issue 30 local browser fixture</h1><p>Creates an isolated synthetic session for native-browser keyboard acceptance.</p><form method="post"><button>Start synthetic test</button></form></main>',
          { headers: { "content-type": "text/html;charset=utf-8" } },
        );
      if (request.method !== "POST" || request.headers.get("origin") !== url.origin)
        return new Response("Forbidden", { status: 403 });
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": "issue30_acceptance=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
        },
      });
    }
    if (
      env.LOCAL_ACCEPTANCE === "true" &&
      request.headers
        .get("cookie")
        ?.split(";")
        .some((cookie) => cookie.trim() === "issue30_acceptance=1")
    ) {
      const fixtureResponse = await issue30ApiFixture(request, url);
      if (fixtureResponse) return fixtureResponse;
    }
    if (url.pathname === "/__acceptance/account" && env.LOCAL_ACCEPTANCE === "true") {
      if (request.method === "GET")
        return new Response(
          '<!doctype html><title>Local acceptance account</title><main style="font:18px system-ui;max-width:600px;margin:80px auto;padding:24px"><h1>Local acceptance account</h1><p>This isolated database tests the production UI and backend using a test identity. No GitHub authentication is claimed.</p><form method="post"><button style="padding:16px 24px;border-radius:24px">Open local test account</button></form></main>',
          { headers: { "content-type": "text/html;charset=utf-8" } },
        );
      if (request.method !== "POST" || request.headers.get("origin") !== url.origin)
        return new Response("Forbidden", { status: 403 });
      const user = await getOrCreateGitHubIdentity(env.DB, {
          id: 900000001,
          login: "local-acceptance",
          name: "Local acceptance account",
          avatarUrl: null,
        }),
        session = await createUserSession(env.DB, user.id, request);
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": authSessionCookie(session.token, false, 30 * 86400),
        },
      });
    }
    if (url.pathname === "/__acceptance/repository" && env.LOCAL_ACCEPTANCE === "true") {
      if (request.method !== "POST" || !["localhost", "127.0.0.1"].includes(url.hostname))
        return new Response("Forbidden", { status: 403 });
      const body = (await request.json().catch(() => null)) as {
        projectId?: unknown;
        fullName?: unknown;
      } | null;
      if (
        typeof body?.projectId !== "string" ||
        typeof body.fullName !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.fullName)
      )
        return new Response("Invalid test repository", { status: 400 });
      const user = await getOrCreateGitHubIdentity(env.DB, {
        id: 900000001,
        login: "local-acceptance",
        name: "Local acceptance account",
        avatarUrl: null,
      });
      const project = await env.DB.prepare("SELECT id FROM projects WHERE id=? AND owner_user_id=?")
        .bind(body.projectId, user.id)
        .first();
      if (!project) return new Response("Project not found", { status: 404 });
      await env.DB.prepare(
        "INSERT INTO project_repositories(project_id,full_name,status,updated_at) VALUES(?,?,'CONNECTED',?)",
      )
        .bind(body.projectId, body.fullName, new Date().toISOString())
        .run();
      return Response.json(
        { data: { projectId: body.projectId, fullName: body.fullName } },
        { status: 201 },
      );
    }
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
