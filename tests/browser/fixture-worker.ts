/** LOCAL ACCEPTANCE ENTRYPOINT ONLY. Not imported by worker/index.ts or the production config. */
import worker from "../../worker/index";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { authSessionCookie } from "../../worker/lib/cookie";
export { RepositoryDiscoveryWorkflow } from "../../worker/repositories/workflow";
declare global {
  interface Env {
    LOCAL_ACCEPTANCE?: string;
  }
}
export default {
  ...worker,
  async fetch(request: Parameters<typeof worker.fetch>[0], env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
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
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
