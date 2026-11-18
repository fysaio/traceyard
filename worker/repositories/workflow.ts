import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { scanRepository } from "./scan";
import { startInitialChecks } from "./checks";
declare global {
  interface Env {
    REPOSITORY_DISCOVERY?: Workflow<{
      projectId: string;
      scanId: string;
      checks?: boolean;
      commitSha?: string;
    }>;
  }
}
export class RepositoryDiscoveryWorkflow extends WorkflowEntrypoint<
  Env,
  { projectId: string; scanId: string; checks?: boolean; commitSha?: string }
> {
  override async run(
    event: WorkflowEvent<{
      projectId: string;
      scanId: string;
      checks?: boolean;
      commitSha?: string;
    }>,
    step: WorkflowStep,
  ) {
    const source = await (async () => {
      const repo = await step.do("source-repository", async () =>
        this.env.DB.prepare(
          "SELECT project_id,installation_id,full_name,default_branch FROM project_repositories WHERE project_id=? AND scan_id=?",
        )
          .bind(event.payload.projectId, event.payload.scanId)
          .first<{
            project_id: string;
            installation_id: number;
            full_name: string;
            default_branch: string;
          }>(),
      );
      if (!repo?.installation_id) return;
      await scanRepository(
        this.env,
        {
          ...repo,
          scan_id: event.payload.scanId,
          ref: event.payload.commitSha,
        },
        fetch,
        step,
      );
    })()
      .then(() => ({ status: "fulfilled" }))
      .catch(() => ({ status: "rejected" }));
    const checks = event.payload.checks
      ? await step.do(
          "start-managed-check",
          { timeout: "3 minutes", retries: { limit: 0, delay: "1 second" } },
          async () => {
            try {
              return await startInitialChecks(
                this.env,
                event.payload.projectId,
                fetch,
                event.payload.scanId,
              );
            } catch {
              return { state: "FAILED" };
            } // Execution availability does not change source discovery.
          },
        )
      : null;
    return { source, checks };
  }
}
