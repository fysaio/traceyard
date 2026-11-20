import type { WorkflowStep } from "cloudflare:workers";
import { discoverFile } from "../../packages/core/src/discovery.mjs";
import { githubRequest } from "./github";
import { ApiError, serviceUnavailable } from "../api/errors";
import { nowIso } from "../lib/time";
declare global {
  interface Env {
    SOURCE_SCAN_FILE_LIMIT?: string;
    SOURCE_SCAN_FILE_BYTES?: string;
  }
}
interface Repo {
  project_id: string;
  scan_id?: string;
  installation_id: number;
  full_name: string;
  default_branch: string;
  ref?: string;
}
export async function scanRepository(
  env: Env,
  repo: Repo,
  fetcher: typeof fetch = fetch,
  step?: WorkflowStep,
) {
  const fileLimit = Math.min(60, Math.max(1, Number(env.SOURCE_SCAN_FILE_LIMIT) || 60)),
    byteLimit = Math.min(64000, Math.max(1000, Number(env.SOURCE_SCAN_FILE_BYTES) || 64000)),
    bounded = fileLimit < 60 || byteLimit < 64000;
  // Persist each file's discovery separately: a free Worker has only 10ms CPU per step.
  // Step results contain metadata, never repository source or installation credentials.
  const perform = async <T extends Rpc.Serializable<T>>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    if (!step) return fn();
    const result = await step.do(
      name,
      { timeout: "1 minute", retries: { limit: 0, delay: "1 second" } },
      async () => {
        try {
          return { value: await fn(), error: null };
        } catch (error) {
          // Workflow serialization drops Error subclasses. Preserve only a known safe API message.
          return {
            value: null,
            error:
              error instanceof ApiError
                ? error.message
                : "Source processing failed. Retry or run local discovery.",
          };
        }
      },
    );
    if (result.error) throw serviceUnavailable("SOURCE_DISCOVERY_FAILED", result.error);
    return result.value as T;
  };

  try {
    const { commit, candidates, warnings } = await perform("source-index", async () => {
      await env.DB.prepare(
        "UPDATE project_repositories SET status='DISCOVERING' WHERE project_id=? AND (? IS NULL OR scan_id=?)",
      )
        .bind(repo.project_id, repo.scan_id ?? null, repo.scan_id ?? null)
        .run();
      const commit = await githubRequest<{ sha: string }>(
        env,
        repo.installation_id,
        `/repos/${repo.full_name}/commits/${encodeURIComponent(repo.ref ?? repo.default_branch)}`,
        {},
        fetcher,
      );
      const tree = await githubRequest<{
        truncated: boolean;
        tree: { path: string; type: string; size?: number; sha: string }[];
      }>(
        env,
        repo.installation_id,
        `/repos/${repo.full_name}/git/trees/${commit.sha}?recursive=1`,
        {},
        fetcher,
      );
      const eligible = tree.tree.filter(
        (f) =>
          f.type === "blob" &&
          /\.[cm]?[jt]sx?$/.test(f.path) &&
          !/(?:^|\/)(?:node_modules|vendor|dist|build|\.git|\.next|coverage)\//.test(f.path) &&
          !/\.(?:test|spec|d)\.[jt]s$/.test(f.path),
      );
      const candidates = eligible.filter((f) => (f.size ?? 0) <= byteLimit);
      // Prefer likely application entry points over helper scripts when coverage is bounded.
      if (bounded)
        candidates.sort((a, b) => {
          const priority = (path: string) =>
            /(?:^|\/)(?:api|routes?|app|server)(?:[/.]|$)|router\.[cm]?[jt]sx?$/.test(path) ? 0 : 1;
          return priority(a.path) - priority(b.path) || a.path.localeCompare(b.path);
        });
      const warnings: string[] = [];
      if (tree.truncated || candidates.length > fileLimit || eligible.length > candidates.length)
        warnings.push(
          `Hosted discovery covers up to ${fileLimit} source files, each at most ${byteLimit / 1000} KB. Run local discovery for wider coverage.`,
        );
      return { commit, candidates: candidates.slice(0, fileLimit), warnings };
    });
    const operations: ReturnType<typeof discoverFile>["operations"] = [];
    let filesScanned = 0;
    async function publish(status: "DISCOVERING" | "DISCOVERED") {
      await env.DB.prepare(
        status === "DISCOVERED"
          ? "UPDATE project_repositories SET commit_sha=?,status=?,scan_json=?,scan_progress_json=NULL,last_error=NULL,updated_at=? WHERE project_id=? AND (? IS NULL OR scan_id=?)"
          : "UPDATE project_repositories SET commit_sha=COALESCE(commit_sha,?),status=?,scan_progress_json=?,last_error=NULL,updated_at=? WHERE project_id=? AND (? IS NULL OR scan_id=?)",
      )
        .bind(
          commit.sha,
          status,
          JSON.stringify({
            operations: operations.slice(0, 100),
            filesScanned,
            totalFiles: candidates.length,
            warnings: warnings.slice(0, 20),
          }),
          nowIso(),
          repo.project_id,
          repo.scan_id ?? null,
          repo.scan_id ?? null,
        )
        .run();
      return true;
    }
    await perform("source-start", () => publish("DISCOVERING"));
    for (const [index, file] of candidates.entries()) {
      try {
        const result = await perform("source-file-" + index, async () => {
          const blob = await githubRequest<{ content: string; encoding: string }>(
            env,
            repo.installation_id,
            `/repos/${repo.full_name}/git/blobs/${file.sha}`,
            {},
            fetcher,
          );
          if (blob.encoding !== "base64")
            return { operations: [], warning: "Unsupported encoding: " + file.path };
          const bytes = Uint8Array.from(atob(blob.content.replace(/\s/g, "")), (c) =>
            c.charCodeAt(0),
          );
          // Keep extra expansion bounded on Workers Free's per-step CPU budget.
          // Larger files retain direct calls; a GitHub runner can enrich them.
          return discoverFile(file.path, new TextDecoder().decode(bytes), {
            includeFlow: !bounded || bytes.length <= 4000,
          });
        });
        operations.push(...result.operations);
        if (result.warning) warnings.push(result.warning);
        filesScanned++;
      } catch (error) {
        if (!bounded) throw error;
        warnings.push(`Could not analyse ${file.path}. Try local discovery for this file.`);
      }
      if (index === 0 || (index + 1) % 8 === 0)
        await perform("source-progress-" + index, () => publish("DISCOVERING"));
    }
    if (candidates.length && !filesScanned) throw Error("No source files could be analysed.");
    if (operations.length > 100) warnings.push("Dashboard discovery is limited to 100 operations.");
    await perform("source-finish", () => publish("DISCOVERED"));
  } catch (error) {
    await perform("source-failed", async () => {
      await env.DB.prepare(
        "UPDATE project_repositories SET status='FAILED',last_error=?,updated_at=? WHERE project_id=? AND (? IS NULL OR scan_id=?)",
      )
        .bind(
          error instanceof ApiError
            ? error.message
            : "Repository discovery stopped. Retry the scan or run local discovery for wider coverage.",
          nowIso(),
          repo.project_id,
          repo.scan_id ?? null,
          repo.scan_id ?? null,
        )
        .run();
      return true;
    });
    throw error;
  }
}
