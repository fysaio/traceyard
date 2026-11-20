// Self-hosted entry. Wraps the built Worker so the container can run the
// five-minute jobs that Cloudflare's cron trigger runs in production.
import app from "../dist/worker/index.js";

export * from "../dist/worker/index.js";

const CRON_PATH = "/__traceyard/scheduled";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === CRON_PATH) {
      const secret = env.TRACEYARD_CRON_SECRET;
      if (
        request.method !== "POST" ||
        !secret ||
        request.headers.get("x-traceyard-cron") !== secret
      )
        return new Response("Not found", { status: 404 });
      await app.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, env, ctx);
      return new Response(null, { status: 204 });
    }
    return app.fetch(request, env, ctx);
  },
  scheduled: app.scheduled,
};
