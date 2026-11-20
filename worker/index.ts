import { createApp } from "./api/app";
import { runScheduledJobs } from "./jobs/scheduled";

export { RepositoryDiscoveryWorkflow } from "./repositories/workflow";
export { RepositoryCheckRunner } from "./repositories/managed-runner";

const app = createApp();

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    void controller;
    ctx.waitUntil(runScheduledJobs(env));
  },
} satisfies ExportedHandler<Env>;
