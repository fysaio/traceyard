import { randomId } from "../lib/crypto";
import { nowIso } from "../lib/time";

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  repository?: string | null;
}

export interface SavedWorkflowSummary {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  description: string;
  definition: unknown;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  created_at: string;
}

interface SavedWorkflowRow {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  description: string;
  definition_json: string;
  created_at: string;
  updated_at: string;
}

export async function getOwnedProject(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<ProjectSummary | null> {
  const row = await db
    .prepare(
      `SELECT p.id, p.slug, p.name, p.created_at, r.full_name AS repository
        FROM projects p
        LEFT JOIN project_repositories r ON r.project_id = p.id
        WHERE p.id = ? AND p.owner_user_id = ?`,
    )
    .bind(projectId, userId)
    .first<ProjectRow & { repository: string | null }>();
  return row === null ? null : toProjectSummary(row);
}

export async function getDefaultProjectId(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM projects WHERE owner_user_id = ?
        ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
    .bind(userId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function listOwnedProjects(db: D1Database, userId: string): Promise<ProjectSummary[]> {
  const result = await db
    .prepare(
      `SELECT p.id, p.slug, p.name, p.created_at, r.full_name AS repository
        FROM projects p
        LEFT JOIN project_repositories r ON r.project_id = p.id
        WHERE p.owner_user_id = ? ORDER BY p.created_at ASC, p.id ASC`,
    )
    .bind(userId)
    .all<ProjectRow & { repository: string | null }>();
  return result.results.map(toProjectSummary);
}

export async function createOwnedProject(
  db: D1Database,
  userId: string,
  name: string,
): Promise<ProjectSummary> {
  const id = randomId("prj");
  const now = nowIso();
  const row: ProjectRow = {
    id,
    slug: `project-${id.slice(4)}`,
    name,
    created_at: now,
  };
  await db
    .prepare(
      `INSERT INTO projects (id, slug, name, kind, created_at, owner_user_id)
       VALUES (?, ?, ?, 'standard', ?, ?)`,
    )
    .bind(row.id, row.slug, row.name, row.created_at, userId)
    .run();
  return toProjectSummary(row);
}

export async function listSavedWorkflows(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<SavedWorkflowSummary[]> {
  const result = await db
    .prepare(
      `SELECT id, project_id, slug, name, description, definition_json, created_at, updated_at
         FROM saved_workflows
        WHERE owner_user_id = ? AND project_id = ?
        ORDER BY updated_at DESC, id ASC`,
    )
    .bind(userId, projectId)
    .all<SavedWorkflowRow>();
  return result.results.map(toSavedWorkflowSummary);
}

export async function getSavedWorkflow(
  db: D1Database,
  userId: string,
  projectId: string,
  workflowId: string,
): Promise<SavedWorkflowSummary | null> {
  const row = await db
    .prepare(
      `SELECT id, project_id, slug, name, description, definition_json, created_at, updated_at
         FROM saved_workflows
        WHERE id = ? AND project_id = ? AND owner_user_id = ?`,
    )
    .bind(workflowId, projectId, userId)
    .first<SavedWorkflowRow>();
  return row === null ? null : toSavedWorkflowSummary(row);
}

export async function createSavedWorkflow(
  db: D1Database,
  options: {
    userId: string;
    projectId: string;
    name: string;
    description: string;
    definition: unknown;
  },
): Promise<SavedWorkflowSummary> {
  const id = randomId("swd");
  const now = nowIso();
  const row: SavedWorkflowRow = {
    id,
    project_id: options.projectId,
    slug: `workflow-${id.slice(4)}`,
    name: options.name,
    description: options.description,
    definition_json: JSON.stringify(options.definition),
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(
      `INSERT INTO saved_workflows (
         id, project_id, owner_user_id, slug, name, description, definition_json, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM projects WHERE id = ? AND owner_user_id = ?
        )`,
    )
    .bind(
      row.id,
      row.project_id,
      options.userId,
      row.slug,
      row.name,
      row.description,
      row.definition_json,
      row.created_at,
      row.updated_at,
      options.projectId,
      options.userId,
    )
    .run();
  const created = await getSavedWorkflow(db, options.userId, options.projectId, row.id);
  if (created === null) throw new Error("Saved workflow could not be read after creation.");
  return created;
}

export async function deleteSavedWorkflow(
  db: D1Database,
  userId: string,
  projectId: string,
  workflowId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM saved_workflows
        WHERE id = ? AND project_id = ? AND owner_user_id = ?
          AND EXISTS (
            SELECT 1 FROM projects WHERE id = ? AND owner_user_id = ?
          )`,
    )
    .bind(workflowId, projectId, userId, projectId, userId)
    .run();
  return result.meta.changes === 1;
}

function toProjectSummary(row: ProjectRow & { repository?: string | null }): ProjectSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: row.created_at,
    repository: row.repository ?? null,
  };
}

function toSavedWorkflowSummary(row: SavedWorkflowRow): SavedWorkflowSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    definition: JSON.parse(row.definition_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
