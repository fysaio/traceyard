import { z } from "zod";

import type { WorkflowSummary } from "../../shared/contracts/api";
import type { WorkflowRow, WorkflowVersionRow } from "./rows";

const stepManifestSchema = z
  .object({
    key: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    ordinal: z.number().int().min(1),
    description: z.string().min(1).max(500),
    timeoutMs: z.number().int().min(1).max(300_000),
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(50),
        baseDelayMs: z.number().int().min(0).max(60_000),
        backoff: z.enum(["fixed", "linear", "exponential"]),
        maxDelayMs: z.number().int().min(0).max(300_000),
      })
      .strict(),
  })
  .strict();

const stepsSchema = z.array(stepManifestSchema).min(1).max(100);

export const SANDBOX_PROJECT_ID = "prj_sandbox";

export interface WorkflowCatalogEntry {
  workflow: WorkflowRow;
  version: WorkflowVersionRow;
  summary: WorkflowSummary;
}

export async function listWorkflowCatalog(
  db: D1Database,
  projectId = SANDBOX_PROJECT_ID,
): Promise<WorkflowCatalogEntry[]> {
  const result = await db
    .prepare(
      `SELECT w.*, v.id AS version_id, v.version AS version_number, v.input_schema_json,
              v.steps_json, v.graph_json, v.checksum, v.created_at AS version_created_at
         FROM workflows w
         JOIN workflow_versions v
           ON v.workflow_id = w.id AND v.version = w.current_version
        WHERE w.project_id = ? AND w.archived_at IS NULL
        ORDER BY w.name ASC`,
    )
    .bind(projectId)
    .all<
      WorkflowRow & {
        version_id: string;
        version_number: number;
        input_schema_json: string;
        steps_json: string;
        graph_json: string | null;
        checksum: string;
        version_created_at: string;
      }
    >();

  return result.results.map((row) => {
    const version: WorkflowVersionRow = {
      id: row.version_id,
      workflow_id: row.id,
      version: row.version_number,
      input_schema_json: row.input_schema_json,
      steps_json: row.steps_json,
      graph_json: row.graph_json,
      checksum: row.checksum,
      created_at: row.version_created_at,
    };
    return {
      workflow: row,
      version,
      summary: toWorkflowSummary(row, version),
    };
  });
}

export async function findWorkflowByIdOrSlug(
  db: D1Database,
  idOrSlug: string,
  projectId = SANDBOX_PROJECT_ID,
  versionNumber?: number,
): Promise<WorkflowCatalogEntry | null> {
  const workflow = await db
    .prepare(
      `SELECT * FROM workflows WHERE project_id = ? AND archived_at IS NULL AND (id = ? OR slug = ?)`,
    )
    .bind(projectId, idOrSlug, idOrSlug)
    .first<WorkflowRow>();
  if (workflow === null) return null;

  const version = await db
    .prepare(`SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?`)
    .bind(workflow.id, versionNumber ?? workflow.current_version)
    .first<WorkflowVersionRow>();
  if (version === null) return null;

  return { workflow, version, summary: toWorkflowSummary(workflow, version) };
}

export function toWorkflowSummary(
  workflow: WorkflowRow,
  version: WorkflowVersionRow,
): WorkflowSummary {
  const parsed = stepsSchema.safeParse(JSON.parse(version.steps_json) as unknown);
  const steps = parsed.success
    ? parsed.data.map((step) => ({
        ...step,
        key: step.key as WorkflowSummary["steps"][number]["key"],
      }))
    : [];
  return {
    id: workflow.id,
    slug: workflow.slug,
    name: workflow.name,
    description: workflow.description,
    version: version.version,
    steps,
    createdAt: workflow.created_at,
    graph: version.graph_json ? JSON.parse(version.graph_json) : null,
  };
}
