import {
  repositoryIndexManifestSchema,
  type IndexedFile,
  type RepositoryIndexManifest,
} from "../../shared/contracts/repository-index";
import { getOwnedProject } from "../persistence/projects";
import { conflict, notFound } from "../api/errors";
import { nowIso } from "../lib/time";

export async function beginRepositoryIndex(
  db: D1Database,
  projectId: string,
  manifest: RepositoryIndexManifest,
) {
  const data = JSON.stringify(manifest);
  await db
    .prepare(
      "INSERT INTO repository_indexes(project_id,snapshot_id,commit_sha,manifest_json,files_expected,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(projectId, manifest.snapshotId, manifest.commit, data, manifest.fileCount, nowIso())
    .run();
  const prior = await db
    .prepare("SELECT manifest_json FROM repository_indexes WHERE project_id=? AND snapshot_id=?")
    .bind(projectId, manifest.snapshotId)
    .first<{ manifest_json: string }>();
  if (prior?.manifest_json !== data)
    throw conflict("INDEX_SNAPSHOT_CHANGED", "An immutable index snapshot cannot be replaced.");
}
export async function uploadRepositoryIndexFiles(
  db: D1Database,
  projectId: string,
  snapshotId: string,
  files: IndexedFile[],
) {
  const manifest = await db
    .prepare(
      "SELECT files_expected,complete FROM repository_indexes WHERE project_id=? AND snapshot_id=?",
    )
    .bind(projectId, snapshotId)
    .first<{ files_expected: number; complete: number }>();
  if (!manifest) throw notFound("Index snapshot not found.");
  for (const file of files) {
    const prior = await db
      .prepare(
        "SELECT metadata_json FROM repository_index_files WHERE project_id=? AND snapshot_id=? AND path=?",
      )
      .bind(projectId, snapshotId, file.path)
      .first<{ metadata_json: string }>();
    if (prior && prior.metadata_json !== JSON.stringify(file))
      throw conflict("INDEX_FILE_CHANGED", "An immutable file record cannot be replaced.");
    if (manifest.complete && !prior)
      throw conflict("INDEX_COMPLETE", "This snapshot is already complete.");
  }
  await db.batch(
    files.map((file) =>
      db
        .prepare(
          "INSERT INTO repository_index_files(project_id,snapshot_id,path,hash,metadata_json) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM repository_index_files WHERE project_id=? AND snapshot_id=?) < ? AND EXISTS(SELECT 1 FROM repository_indexes WHERE project_id=? AND snapshot_id=? AND complete=0) ON CONFLICT DO NOTHING",
        )
        .bind(
          projectId,
          snapshotId,
          file.path,
          file.hash,
          JSON.stringify(file),
          projectId,
          snapshotId,
          manifest.files_expected,
          projectId,
          snapshotId,
        ),
    ),
  );
  const count = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM repository_index_files WHERE project_id=? AND snapshot_id=?",
    )
    .bind(projectId, snapshotId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) > manifest.files_expected)
    throw conflict("INDEX_FILE_LIMIT", "The snapshot contains more files than declared.");
  const stored = await db
    .prepare(
      `SELECT path,metadata_json FROM repository_index_files WHERE project_id=? AND snapshot_id=? AND path IN (${files.map(() => "?").join(",")})`,
    )
    .bind(projectId, snapshotId, ...files.map((f) => f.path))
    .all<{ path: string; metadata_json: string }>();
  if (
    files.some(
      (f) => stored.results.find((r) => r.path === f.path)?.metadata_json !== JSON.stringify(f),
    )
  )
    throw conflict(
      "INDEX_FILE_LIMIT",
      "The upload conflicts with the immutable snapshot or its file limit.",
    );
}
export async function completeRepositoryIndex(
  db: D1Database,
  projectId: string,
  snapshotId: string,
) {
  const result = await db
    .prepare(
      "UPDATE repository_indexes SET complete=1 WHERE project_id=? AND snapshot_id=? AND files_expected=(SELECT COUNT(*) FROM repository_index_files WHERE project_id=? AND snapshot_id=?) RETURNING snapshot_id",
    )
    .bind(projectId, snapshotId, projectId, snapshotId)
    .first();
  if (!result)
    throw conflict(
      "INDEX_INCOMPLETE",
      "The index is unavailable until every declared file has arrived.",
    );
  return { snapshotId, complete: true };
}
export async function getRepositoryIndex(
  db: D1Database,
  userId: string,
  projectId: string,
  path?: string,
  commit?: string,
) {
  if (!(await getOwnedProject(db, userId, projectId))) throw notFound("Project not found.");
  const row = await db
    .prepare(
      "SELECT snapshot_id,manifest_json FROM repository_indexes WHERE project_id=? AND complete=1 AND (? IS NULL OR commit_sha=?) ORDER BY created_at DESC,snapshot_id DESC LIMIT 1",
    )
    .bind(projectId, commit ?? null, commit ?? null)
    .first<{ snapshot_id: string; manifest_json: string }>();
  if (!row) return null;
  const manifest = repositoryIndexManifestSchema.parse(JSON.parse(row.manifest_json));
  const files = await db
    .prepare(
      "SELECT metadata_json FROM repository_index_files WHERE project_id=? AND snapshot_id=? AND (? IS NULL OR path=?) ORDER BY path LIMIT 101",
    )
    .bind(projectId, row.snapshot_id, path ?? null, path ?? null)
    .all<{ metadata_json: string }>();
  const tests = path
    ? await db
        .prepare(
          `WITH RECURSIVE affected(path) AS (
    SELECT path FROM repository_index_files WHERE project_id=? AND snapshot_id=? AND path=?
    UNION
    SELECT f.path FROM repository_index_files f,json_each(f.metadata_json,'$.imports') i JOIN affected a ON json_extract(i.value,'$.resolved')=a.path WHERE f.project_id=? AND f.snapshot_id=?
  ) SELECT f.metadata_json FROM repository_index_files f JOIN affected a ON a.path=f.path WHERE f.project_id=? AND f.snapshot_id=? AND json_extract(f.metadata_json,'$.isTest')=1 ORDER BY f.path LIMIT 101`,
        )
        .bind(
          projectId,
          row.snapshot_id,
          path,
          projectId,
          row.snapshot_id,
          projectId,
          row.snapshot_id,
        )
        .all<{ metadata_json: string }>()
    : null;
  return {
    ...manifest,
    files: files.results.slice(0, 100).map((f) => JSON.parse(f.metadata_json) as IndexedFile),
    relatedTests:
      tests?.results.slice(0, 100).map((f) => JSON.parse(f.metadata_json) as IndexedFile) ?? [],
    truncated: files.results.length > 100 || (tests?.results.length ?? 0) > 100,
  };
}
