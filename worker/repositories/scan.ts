import { discoverFile } from "../../agent/discovery.mjs";
import { githubRequest } from "./github";
import { ApiError } from "../api/errors";
import { nowIso } from "../lib/time";
interface Repo {
  project_id: string;
  scan_id?: string;
  installation_id: number;
  full_name: string;
  default_branch: string;
}
export async function scanRepository(env: Env, repo: Repo, fetcher: typeof fetch = fetch) {
  try {
    await env.DB.prepare(
      "UPDATE project_repositories SET status='DISCOVERING' WHERE project_id=? AND (? IS NULL OR scan_id=?)",
    )
      .bind(repo.project_id, repo.scan_id ?? null, repo.scan_id ?? null)
      .run();
    const commit = await githubRequest<{ sha: string }>(
      env,
      repo.installation_id,
      `/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`,
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
    const candidates = tree.tree.filter(
      (f) =>
        f.type === "blob" &&
        /\.[cm]?[jt]sx?$/.test(f.path) &&
        !/(?:^|\/)(?:node_modules|vendor|dist|build|\.git|\.next|coverage)\//.test(f.path) &&
        !/\.(?:test|spec|d)\.[jt]s$/.test(f.path) &&
        (f.size ?? 0) <= 64000,
    );
    const warnings: string[] = [];
    if (tree.truncated || candidates.length > 60)
      warnings.push("This scan is limited to 60 source files. Additional files are not analysed.");
    const operations: ReturnType<typeof discoverFile>["operations"] = [];
    // Sequential fetches keep GitHub rate use bounded. Each source stays in memory, never in D1.
    for (const file of candidates.slice(0, 60)) {
      const blob = await githubRequest<{ content: string; encoding: string }>(
        env,
        repo.installation_id,
        `/repos/${repo.full_name}/git/blobs/${file.sha}`,
        {},
        fetcher,
      );
      if (blob.encoding !== "base64") {
        warnings.push("Unsupported encoding: " + file.path);
        continue;
      }
      const bytes = Uint8Array.from(atob(blob.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
      const result = discoverFile(file.path, new TextDecoder().decode(bytes));
      operations.push(...result.operations);
      if (result.warning) warnings.push(result.warning);
    }
    const scan = {
      operations: operations.slice(0, 100),
      filesScanned: Math.min(candidates.length, 60),
      warnings: warnings.slice(0, 20),
    };
    await env.DB.prepare(
      "UPDATE project_repositories SET commit_sha=?,status='DISCOVERED',scan_json=?,last_error=NULL,updated_at=? WHERE project_id=? AND (? IS NULL OR scan_id=?)",
    )
      .bind(
        commit.sha,
        JSON.stringify(scan),
        nowIso(),
        repo.project_id,
        repo.scan_id ?? null,
        repo.scan_id ?? null,
      )
      .run();
  } catch (error) {
    await env.DB.prepare(
      "UPDATE project_repositories SET status='FAILED',last_error=?,updated_at=? WHERE project_id=? AND (? IS NULL OR scan_id=?)",
    )
      .bind(
        error instanceof ApiError
          ? error.message
          : "Repository discovery failed. Check GitHub App access, then retry.",
        nowIso(),
        repo.project_id,
        repo.scan_id ?? null,
        repo.scan_id ?? null,
      )
      .run();
    throw error;
  }
}
