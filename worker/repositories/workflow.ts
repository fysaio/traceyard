import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { scanRepository } from "./scan";
import { startInitialChecks } from "./checks";
declare global {
  interface Env {
    REPOSITORY_DISCOVERY?: Workflow<{ projectId: string; scanId: string; checks?: boolean }>;
  }
}
export class RepositoryDiscoveryWorkflow extends WorkflowEntrypoint<
  Env,
  { projectId: string; scanId: string; checks?: boolean }
> {
  override async run(
    event: WorkflowEvent<{ projectId: string; scanId: string; checks?: boolean }>,
    step: WorkflowStep,
  ) {
    const source = step.do(
      "discover-source",
      { timeout: "10 minutes", retries: { limit: 2, delay: "5 seconds" } },
      async () => {
        const repo = await this.env.DB.prepare(
          "SELECT project_id,installation_id,full_name,default_branch FROM project_repositories WHERE project_id=? AND scan_id=?",
        )
          .bind(event.payload.projectId, event.payload.scanId)
          .first<{
            project_id: string;
            installation_id: number;
            full_name: string;
            default_branch: string;
          }>();
        if (!repo?.installation_id) return;
        await scanRepository(this.env, { ...repo, scan_id: event.payload.scanId });
      },
    );
    const checks = event.payload.checks
      ? step.do(
          "prepare-project-checks",
          { timeout: "3 minutes", retries: { limit: 0, delay: "1 second" } },
          async () => {
            try {
              return await startInitialChecks(this.env, event.payload.projectId);
            } catch {
              return { state: "FAILED" };
            } // Setup errors are persisted separately; source discovery continues.
          },
        )
      : Promise.resolve(null);
    const results = await Promise.allSettled([source, checks]);
    return results.map((result) => ({ status: result.status }));
  }
}
