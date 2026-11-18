import type {
  Investigation,
  InvestigationEvidence,
  InvestigationRequest,
  InvestigationTarget,
  SourceSnapshot,
} from "../../shared/contracts/investigations";
import { redact } from "../../shared/contracts/traces";
import { getOwnedProject } from "../persistence/projects";
import { randomId, sha256Hex } from "../lib/crypto";
import { nowIso } from "../lib/time";
import { conflict, notFound } from "../api/errors";
import { operationKey } from "../repositories/catalog";
import { getRepositoryIndex } from "./repository-index-service";
import type { InvestigationReport } from "../../shared/contracts/investigation-execution";

interface Row {
  id: string;
  project_id: string;
  owner_user_id: string;
  question: string;
  request_hash: string;
  target_json: string;
  snapshot_json: string;
  status: Investigation["status"];
  finding_json: string;
  output_chars: number;
  created_at: string;
  updated_at: string;
}
interface EvidenceRow {
  id: string;
  kind: InvestigationEvidence["kind"];
  basis: InvestigationEvidence["basis"];
  title: string;
  content_json: string;
  truncated: number;
}
export async function requireInvestigationProject(
  db: D1Database,
  userId: string,
  projectId: string,
) {
  if (!(await getOwnedProject(db, userId, projectId))) throw notFound("Project not found.");
}
function bounded(value: unknown, max = 16000): { content: unknown; truncated: boolean } {
  const content = redact(value),
    text = JSON.stringify(content);
  return text.length <= max
    ? { content, truncated: false }
    : {
        content: { preview: text.slice(0, max - 100), omitted: true },
        truncated: true,
      };
}
function view(row: Row, evidence: Omit<EvidenceRow, "content_json">[]): Investigation {
  const finding = JSON.parse(row.finding_json) as Investigation["finding"];
  const full = finding.summary;
  finding.summary = full.slice(0, row.output_chars);
  return {
    schemaVersion: 1,
    id: row.id,
    projectId: row.project_id,
    question: row.question,
    target: JSON.parse(row.target_json),
    status: row.status,
    snapshot: JSON.parse(row.snapshot_json),
    finding,
    evidence: evidence.map(({ id, kind, basis, title, truncated }) => ({
      id,
      kind,
      basis,
      title,
      truncated: !!truncated,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    browserPath: `/investigations/${row.id}?project=${encodeURIComponent(row.project_id)}`,
    budget: {
      outputChars: row.output_chars,
      returnedChars: finding.summary.length,
      truncated: full.length > finding.summary.length,
    },
  };
}
export async function getInvestigation(
  db: D1Database,
  userId: string,
  projectId: string,
  id: string,
) {
  await requireInvestigationProject(db, userId, projectId);
  const row = await db
    .prepare("SELECT * FROM investigations WHERE id=? AND project_id=? AND owner_user_id=?")
    .bind(id, projectId, userId)
    .first<Row>();
  if (!row) throw notFound("Investigation not found.");
  const evidence = await db
    .prepare(
      "SELECT id, kind, basis, title, truncated FROM investigation_evidence WHERE investigation_id=? ORDER BY id LIMIT 100",
    )
    .bind(id)
    .all<Omit<EvidenceRow, "content_json">>();
  const attempts = await db
    .prepare(
      "SELECT id,request_id AS requestId,status,check_id AS checkId,created_at AS createdAt FROM investigation_attempts WHERE investigation_id=? ORDER BY created_at,id LIMIT 10",
    )
    .bind(id)
    .all<{
      id: string;
      requestId: string;
      status: string;
      checkId: string | null;
      createdAt: string;
    }>();
  const recordings = await db
    .prepare(
      "SELECT id,eligible,created_at AS createdAt FROM investigation_recordings WHERE investigation_id=? ORDER BY created_at DESC LIMIT 5",
    )
    .bind(id)
    .all<{ id: string; eligible: number; createdAt: string }>();
  const latest = await db
    .prepare(
      "SELECT report_json FROM investigation_attempts WHERE investigation_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .bind(id)
    .first<{ report_json: string | null }>();
  const report = latest?.report_json
    ? (JSON.parse(latest.report_json) as InvestigationReport)
    : null;
  const verifications = await db
    .prepare(
      "SELECT id,baseline_id AS baselineId,candidate_id AS candidateId,candidate_commit AS candidateCommit,created_at AS createdAt FROM investigation_verifications WHERE project_id=? AND (baseline_id=? OR candidate_id=?) ORDER BY created_at DESC,id DESC LIMIT 5",
    )
    .bind(projectId, id, id)
    .all<NonNullable<Investigation["verifications"]>[number]>();
  return {
    ...view(row, evidence.results),
    attempts: attempts.results,
    recordings: recordings.results.map((r) => ({ ...r, eligible: !!r.eligible })),
    ...(report
      ? {
          execution: {
            status: report.status,
            commit: report.commit,
            command: report.command,
            counts: report.counts,
            durationMs: report.durationMs,
            exitCode: report.exitCode,
            failures: report.failures
              .slice(0, 3)
              .map((failure) => ({ ...failure, message: failure.message.slice(0, 2000) })),
            coverage: report.coverage,
          },
        }
      : {}),
    verifications: verifications.results,
  };
}
export async function listInvestigations(db: D1Database, userId: string, projectId: string) {
  await requireInvestigationProject(db, userId, projectId);
  const rows = await db
    .prepare(
      "SELECT * FROM investigations WHERE project_id=? AND owner_user_id=? ORDER BY created_at DESC,id DESC LIMIT 50",
    )
    .bind(projectId, userId)
    .all<Row>();
  return rows.results.map((r) => view(r, []));
}
export async function getInvestigationStatus(
  db: D1Database,
  userId: string,
  projectId: string,
  id: string,
) {
  const row = await db
    .prepare(
      `SELECT i.id, i.status, i.finding_json FROM investigations i
      JOIN projects p ON p.id=i.project_id AND p.owner_user_id=i.owner_user_id
      WHERE i.id=? AND i.project_id=? AND i.owner_user_id=?`,
    )
    .bind(id, projectId, userId)
    .first<Pick<Row, "id" | "status" | "finding_json">>();
  if (!row) throw notFound("Investigation not found.");
  const finding = JSON.parse(row.finding_json) as Investigation["finding"];
  return {
    investigationId: row.id,
    status: row.status,
    summary: finding.summary.slice(0, 250),
    nextPollAfterMs: row.status === "EXECUTING" ? 5000 : null,
  };
}
export async function inspectEvidence(
  db: D1Database,
  userId: string,
  projectId: string,
  id: string,
  evidenceId: string,
  offset = 0,
  limit = 3000,
) {
  const row = await db
    .prepare(
      `SELECT e.* FROM investigation_evidence e
        JOIN investigations i ON i.id=e.investigation_id
        JOIN projects p ON p.id=i.project_id AND p.owner_user_id=i.owner_user_id
        WHERE e.id=? AND i.id=? AND i.project_id=? AND i.owner_user_id=?`,
    )
    .bind(evidenceId, id, projectId, userId)
    .first<EvidenceRow>();
  if (!row) throw notFound("Evidence not found.");
  const text = row.content_json,
    end = Math.min(text.length, offset + limit);
  return {
    id: row.id,
    kind: row.kind,
    basis: row.basis,
    title: row.title,
    text: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
    truncated: !!row.truncated,
    totalChars: text.length,
  };
}
async function collect(
  db: D1Database,
  userId: string,
  projectId: string,
  target: InvestigationTarget = { kind: "source" },
) {
  const evidence: Omit<InvestigationEvidence, "id">[] = [];
  const repo = await db
    .prepare(
      "SELECT full_name,commit_sha,scan_json,scan_progress_json,status FROM project_repositories WHERE project_id=?",
    )
    .bind(projectId)
    .first<{
      full_name: string;
      commit_sha: string | null;
      scan_json: string | null;
      scan_progress_json: string | null;
      status: string;
    }>();
  const scan = JSON.parse(repo?.scan_json ?? repo?.scan_progress_json ?? "{}") as {
    filesScanned?: number;
    warnings?: string[];
    operations?: { file: string; name: string; line: number; calls: string[] }[];
  };
  const snapshot: SourceSnapshot = {
    repository: repo?.full_name ?? null,
    commit: repo?.commit_sha ?? null,
    filesScanned: scan.filesScanned ?? 0,
    warnings: (scan.warnings ?? []).slice(0, 20),
  };
  let summary: string, nextAction: string | null;
  const limitations = [
    "Source relationships describe possible behavior, not an observed execution.",
  ];
  if (target.kind === "source") {
    let operations = scan.operations ?? [];
    if (target.operationKey) {
      const keys = await Promise.all(
        operations.map(async (o) => ({ o, key: await operationKey(o.file, o.name) })),
      );
      operations = keys.filter((x) => x.key === target.operationKey).map((x) => x.o);
      if (!operations.length) throw notFound("Source operation not found.");
    }
    evidence.push({
      kind: "source",
      basis: "source",
      title: "Indexed source operations",
      ...bounded({ operations: operations.slice(0, 30), snapshot }),
    });
    summary = operations.length
      ? `Found ${operations.length} indexed operation(s) in ${snapshot.filesScanned} scanned file(s). Runtime behavior has not been verified by this investigation.`
      : "No supported operations are indexed yet. Repository analysis remains available after source discovery completes.";
    nextAction = operations.length
      ? "Select an operation or investigate an existing failed check."
      : "Connect a repository or refresh source discovery.";
    if (operations.length > 30) limitations.push("The evidence contains the first 30 operations.");
    const index = await getRepositoryIndex(
      db,
      userId,
      projectId,
      target.operationKey ? operations[0]?.file : undefined,
      snapshot.commit ?? undefined,
    );
    if (index) {
      snapshot.commit = index.commit;
      snapshot.filesScanned = index.coverage.scanned;
      snapshot.warnings = index.coverage.warnings;
      evidence.push({
        kind: "source",
        basis: "source",
        title: "Repository packages and related tests",
        ...bounded(index),
      });
      const tests = target.operationKey ? index.relatedTests : index.files.filter((f) => f.isTest);
      summary += ` Indexed ${index.fileCount} source/test files across ${index.packages.length} package(s); ${tests.length} test file(s) in this view.`;
      if (tests.length)
        nextAction = "Run a selected existing test in an available execution environment.";
      if (index.truncated)
        limitations.push(
          "The index view is paginated; not all file records are included in this evidence.",
        );
    }
  } else if (target.kind === "check") {
    const check = await db
      .prepare(
        "SELECT id,commit_sha,phase,status,events_json,source,updated_at FROM repository_jobs WHERE id=? AND project_id=?",
      )
      .bind(target.ref, projectId)
      .first<{
        id: string;
        commit_sha: string | null;
        phase: string;
        status: string;
        events_json: string;
        source: string;
        updated_at: string;
      }>();
    if (!check) throw notFound("Check not found.");
    snapshot.commit = check.commit_sha;
    if (check.commit_sha !== repo?.commit_sha) {
      snapshot.filesScanned = 0;
      snapshot.warnings = ["The source index does not match this check's revision."];
    }
    evidence.push({
      kind: "check",
      basis: "observed",
      title: "Reported repository check",
      ...bounded(check),
    });
    const events = JSON.parse(check.events_json) as { message?: string }[];
    summary = `${check.phase}: ${check.status}. ${events.at(-1)?.message ?? "Inspect retained check events."}`;
    limitations.push("A command result does not prove that an application operation was traced.");
    nextAction =
      check.status === "FAILED"
        ? "Inspect the reported failure and reproduce the affected test."
        : "Inspect application traces or select a focused test.";
  } else if (target.kind === "trace") {
    const spans = await db
      .prepare(
        "SELECT name,status,started_at,ended_at,attributes_json,error_json FROM trace_spans WHERE project_id=? AND trace_id=? ORDER BY started_at,span_id LIMIT 101",
      )
      .bind(projectId, target.ref)
      .all<{ name: string; status: string; attributes_json: string; error_json: string | null }>();
    if (!spans.results.length) throw notFound("Trace not found.");
    const failed = spans.results.filter((s) => s.status === "FAILED");
    evidence.push({
      kind: "trace",
      basis: "observed",
      title: "Recorded trace spans",
      ...bounded(spans.results.slice(0, 100)),
      truncated: spans.results.length > 100 || bounded(spans.results.slice(0, 100)).truncated,
    });
    summary = failed.length
      ? `${failed.length} recorded span(s) failed. ${failed
          .slice(0, 3)
          .map((s) => `${s.name}: ${s.error_json ?? "No error detail retained"}`)
          .join("; ")}`
      : "The retained spans report no failure. This does not establish complete application coverage.";
    snapshot.commit = null;
    snapshot.filesScanned = 0;
    limitations.push(
      "The trace's exact source revision is unconfirmed; the current repository revision is not substituted.",
      "Telemetry is not a replay recording or a continuation checkpoint.",
    );
    nextAction =
      "Inspect the failed span evidence or reproduce the request in an available environment.";
  } else {
    const run = await db
      .prepare(
        "SELECT id,status,workflow_id,workflow_version,error_json,parent_run_id,recovery_mode FROM runs WHERE id=? AND project_id=?",
      )
      .bind(target.ref, projectId)
      .first<{ id: string; status: string; error_json: string | null }>();
    if (!run) throw notFound("Execution not found.");
    const steps = await db
      .prepare(
        "SELECT step_key,name,status,attempt_count,error_json,reused_from_run_id FROM execution_steps WHERE run_id=? ORDER BY ordinal LIMIT 100",
      )
      .bind(target.ref)
      .all();
    evidence.push({
      kind: "execution",
      basis: "observed",
      title: "Traceyard execution and checkpoints",
      ...bounded({ run, steps: steps.results }),
    });
    snapshot.commit = null;
    snapshot.filesScanned = 0;
    summary = `Traceyard workflow execution ${run.status}. ${run.error_json ?? "Inspect steps for retained execution evidence."}`;
    limitations.push(
      "This execution belongs to a Traceyard-defined workflow; it is not execution of an arbitrary repository function.",
    );
    nextAction =
      run.status === "FAILED"
        ? "Inspect checkpoints before choosing resume or restart."
        : "Inspect the recorded output and attempts.";
  }
  return {
    snapshot,
    evidence,
    finding: {
      summary: String(redact(summary)),
      basis: target.kind === "source" ? ("source" as const) : ("observed" as const),
      limitations: [...limitations, ...snapshot.warnings],
      nextAction,
    },
  };
}
export async function createInvestigation(
  db: D1Database,
  userId: string,
  projectId: string,
  request: InvestigationRequest,
  snapshotOverride?: SourceSnapshot,
) {
  await requireInvestigationProject(db, userId, projectId);
  const hash = await sha256Hex(
    JSON.stringify({ request, snapshotOverride: snapshotOverride ?? null }),
  );
  const previous = request.requestKey
    ? await db
        .prepare("SELECT id,request_hash FROM investigations WHERE project_id=? AND request_key=?")
        .bind(projectId, request.requestKey)
        .first<{ id: string; request_hash: string }>()
    : null;
  if (previous) {
    if (previous.request_hash !== hash)
      throw conflict(
        "INVESTIGATION_REQUEST_REUSED",
        "This request key belongs to a different investigation request.",
      );
    return getInvestigation(db, userId, projectId, previous.id);
  }
  const result = snapshotOverride
      ? {
          snapshot: snapshotOverride,
          evidence: [] as Omit<InvestigationEvidence, "id">[],
          finding: {
            summary: "Selected revision snapshot; execution has not completed.",
            basis: "source" as const,
            limitations: ["The selected revision has not yet been executed."],
            nextAction: "Execute the selected test against this revision.",
          },
        }
      : await collect(db, userId, projectId, request.target),
    id = randomId("inv"),
    now = nowIso();
  const statements = [
    db
      .prepare(
        "INSERT INTO investigations(id,project_id,owner_user_id,request_key,request_hash,question,target_json,snapshot_json,status,finding_json,output_chars,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        projectId,
        userId,
        request.requestKey ?? null,
        hash,
        String(redact(request.question)),
        JSON.stringify(request.target),
        JSON.stringify(result.snapshot),
        "EVIDENCE_READY",
        JSON.stringify(result.finding),
        request.outputChars,
        now,
        now,
      ),
    ...result.evidence.map((e) =>
      db
        .prepare(
          "INSERT INTO investigation_evidence(id,investigation_id,kind,basis,title,content_json,truncated,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          randomId("evd"),
          id,
          e.kind,
          e.basis,
          e.title,
          JSON.stringify(e.content),
          Number(e.truncated),
          now,
        ),
    ),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    const concurrent = request.requestKey
      ? await db
          .prepare(
            "SELECT id,request_hash FROM investigations WHERE project_id=? AND request_key=?",
          )
          .bind(projectId, request.requestKey)
          .first<{ id: string; request_hash: string }>()
      : null;
    if (!concurrent) throw error;
    if (concurrent.request_hash !== hash)
      throw conflict(
        "INVESTIGATION_REQUEST_REUSED",
        "This request key belongs to a different investigation request.",
      );
    return getInvestigation(db, userId, projectId, concurrent.id);
  }
  return getInvestigation(db, userId, projectId, id);
}
