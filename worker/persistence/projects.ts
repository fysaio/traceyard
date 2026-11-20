import { randomId } from "../lib/crypto";
import { nowIso } from "../lib/time";

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  repository?: string | null;
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  created_at: string;
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

function toProjectSummary(row: ProjectRow & { repository?: string | null }): ProjectSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: row.created_at,
    repository: row.repository ?? null,
  };
}
