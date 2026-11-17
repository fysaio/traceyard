import type { Operation, ApplicationRun, Catalog } from "../../shared/repository/workspace";
import { runnerConfigSchema } from "../../shared/repository/workspace";
import type { RepositoryRecord, RepositoryJob } from "../../shared/repository/contracts";
import type { DiscoveredOperation } from "../../agent/discovery.mjs";
import { sha256Hex } from "../lib/crypto";
import { getOwnedProject } from "../persistence/projects";
import { notFound } from "../api/errors";
import { syncRepositoryChecks } from "./check-sync";
import { githubChecksAvailable, syncGitHubDispatches } from "./github-checks";
import { managedChecksAvailable } from "./managed";
export async function operationKey(file: string, name: string) {
  return "op_" + (await sha256Hex(file + "\0" + name)).slice(0, 32);
}
export async function applicationRuns(
  db: D1Database,
  projectId: string,
  limit = 500,
): Promise<ApplicationRun[]> {
  const rows = await db
    .prepare(
      `SELECT trace_id AS id,COALESCE(MIN(CASE WHEN parent_span_id IS NULL THEN name END),MIN(name)) AS name,
    MIN(started_at) AS startedAt,MAX(ended_at) AS endedAt,COUNT(*) AS steps,
    COALESCE(MAX(CASE WHEN parent_span_id IS NULL THEN status END),CASE WHEN SUM(status='FAILED')>0 THEN 'FAILED' WHEN SUM(status='RUNNING')>0 THEN 'RUNNING' ELSE 'SUCCEEDED' END) AS status,
    COALESCE(MIN(CASE WHEN parent_span_id IS NULL THEN attributes_json END),'{}') AS attrs
    FROM trace_spans WHERE project_id=? GROUP BY trace_id ORDER BY MIN(started_at) DESC LIMIT ?`,
    )
    .bind(projectId, limit)
    .all<Omit<ApplicationRun, "attributes" | "checkId" | "commit"> & { attrs: string }>();
  return rows.results.map(({ attrs, ...r }) => {
    const attributes = JSON.parse(attrs) as Record<string, unknown>;
    return {
      ...r,
      attributes,
      checkId:
        typeof attributes["traceyard.run.id"] === "string" ? attributes["traceyard.run.id"] : null,
      commit:
        typeof attributes["service.version"] === "string" ? attributes["service.version"] : null,
    };
  });
}
export async function projectCatalog(
  env: Env,
  userId: string,
  projectId: string,
): Promise<Catalog> {
  const project = await getOwnedProject(env.DB, userId, projectId);
  if (!project) throw notFound("Project not found.");
  await syncGitHubDispatches(env, projectId);
  await syncRepositoryChecks(env, projectId);
  const [repository, runs, jobs, config, cases, managed] = await Promise.all([
    env.DB.prepare("SELECT * FROM project_repositories WHERE project_id=?")
      .bind(projectId)
      .first<RepositoryRecord>(),
    applicationRuns(env.DB, projectId),
    env.DB.prepare(
      "SELECT * FROM repository_jobs WHERE project_id=? ORDER BY updated_at DESC LIMIT 20",
    )
      .bind(projectId)
      .all<RepositoryJob>(),
    env.DB.prepare("SELECT config_json FROM repository_runner_configs WHERE project_id=?")
      .bind(projectId)
      .first<{ config_json: string }>(),
    env.DB.prepare(
      "SELECT operation_key,COUNT(*) AS count FROM repository_test_cases WHERE project_id=? GROUP BY operation_key",
    )
      .bind(projectId)
      .all<{ operation_key: string; count: number }>(),
    env.DB.prepare(
      "SELECT r.id,w.name,r.status,r.created_at AS startedAt,r.completed_at AS endedAt,(SELECT COUNT(*) FROM execution_steps WHERE run_id=r.id) AS steps FROM runs r JOIN workflows w ON w.id=r.workflow_id WHERE r.project_id=? ORDER BY r.created_at DESC LIMIT 100",
    )
      .bind(projectId)
      .all<ApplicationRun>(),
  ]);
  const sourceIndex = repository?.scan_json ?? repository?.scan_progress_json;
  const scan = sourceIndex
    ? (JSON.parse(sourceIndex) as {
        operations: DiscoveredOperation[];
        warnings: string[];
        filesScanned: number;
      })
    : null;
  const foundSources = await Promise.all(
    (scan?.operations ?? []).map(async (o) => ({ ...o, key: await operationKey(o.file, o.name) })),
  );
  const sourceMap = new Map<string, (typeof foundSources)[number]>();
  for (const source of foundSources) {
    const previous = sourceMap.get(source.key);
    sourceMap.set(
      source.key,
      previous
        ? { ...previous, calls: [...new Set([...previous.calls, ...source.calls])].slice(0, 12) }
        : source,
    );
  }
  const sources = [...sourceMap.values()];
  const assigned = new Set<string>();
  const operations: Operation[] = sources.map((o) => {
    const sameRoute = sources.filter((other) => other.name === o.name);
    const matches = runs.filter((run) => {
      const explicit = run.attributes["traceyard.operation.key"];
      if (explicit) return explicit === o.key;
      const route = run.attributes["http.route"],
        method = run.attributes["http.request.method"] ?? run.attributes["http.method"];
      const file = run.attributes["code.file.path"] ?? run.attributes["code.filepath"];
      if (
        typeof file === "string" &&
        (file === o.file || file.endsWith("/" + o.file)) &&
        (run.name === o.name || run.attributes["code.function.name"] === o.name)
      )
        return true;
      return (
        sameRoute.length === 1 &&
        typeof route === "string" &&
        typeof method === "string" &&
        `${method.toUpperCase()} ${route}` === o.name
      );
    });
    matches.forEach((r) => {
      assigned.add(r.id);
      r.operationKey = o.key;
    });
    return {
      key: o.key,
      name: o.name,
      kind: o.kind,
      file: o.file,
      line: o.line,
      calls: o.calls,
      evidence: matches.length ? "linked" : "source",
      runtimeNames: [...new Set(matches.map((r) => r.name))],
      runs: matches.length,
      failed: matches.filter((r) => r.status === "FAILED").length,
      lastRunAt: matches[0]?.startedAt ?? null,
      testCases: cases.results.find((c) => c.operation_key === o.key)?.count ?? 0,
    };
  });
  const groups = new Map<string, ApplicationRun[]>();
  runs
    .filter((r) => !assigned.has(r.id))
    .forEach((r) => {
      const service = String(r.attributes.service ?? "Application"),
        k = service + "\0" + r.name;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    });
  for (const [group, items] of groups) {
    const key = await operationKey("recorded", group);
    items.forEach((r) => {
      r.operationKey = key;
    });
    operations.push({
      key,
      name: items[0]!.name,
      kind: "recorded",
      file: null,
      line: null,
      calls: [],
      evidence: "recorded",
      runtimeNames: [items[0]!.name],
      runs: items.length,
      failed: items.filter((r) => r.status === "FAILED").length,
      lastRunAt: items[0]!.startedAt,
      testCases: 0,
    });
  }
  return {
    project,
    repository,
    operations,
    runs,
    jobs: jobs.results,
    managedRuns: managed.results.map((r) => ({
      ...r,
      source: "managed",
      attributes: {},
      checkId: null,
      commit: null,
    })),
    config: config
      ? runnerConfigSchema.parse(JSON.parse(config.config_json))
      : runnerConfigSchema.parse({}),
    warnings: scan?.warnings ?? [],
    filesScanned: scan?.filesScanned ?? 0,
    executionAvailable:
      managedChecksAvailable(env) || (!!repository?.repository_id && githubChecksAvailable(env)),
    executionProvider: managedChecksAvailable(env)
      ? "managed"
      : repository?.repository_id && githubChecksAvailable(env)
        ? "github"
        : null,
  };
}
