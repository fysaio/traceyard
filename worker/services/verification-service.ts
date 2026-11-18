import { investigationRequestSchema } from "../../shared/contracts/investigations";
import type { InvestigationReport } from "../../shared/contracts/investigation-execution";
import type { Verification } from "../../shared/contracts/verification";
import { createInvestigation, getInvestigation } from "./investigation-service";
import { startInvestigationExecution } from "./investigation-execution";
import { githubRequest } from "../repositories/github";
import { badRequest, conflict, notFound } from "../api/errors";
import { randomId, sha256Hex } from "../lib/crypto";
import { getRecording } from "./recording-service";
import { nowIso } from "../lib/time";
const testFile = (p: string) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|tests?|fixtures?)\//.test(p);
async function latestReport(db: D1Database, id: string) {
  const row = await db
    .prepare(
      "SELECT report_json FROM investigation_attempts WHERE investigation_id=? AND report_json IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .bind(id)
    .first<{ report_json: string }>();
  return row ? (JSON.parse(row.report_json) as InvestigationReport) : null;
}
export async function getVerification(
  db: D1Database,
  userId: string,
  projectId: string,
  id: string,
): Promise<Verification> {
  const row = await db
    .prepare("SELECT * FROM investigation_verifications WHERE id=? AND project_id=?")
    .bind(id, projectId)
    .first<{
      id: string;
      baseline_id: string;
      candidate_id: string;
      candidate_commit: string;
      changed_files_json: string;
      limitations_json: string;
    }>();
  if (!row) throw notFound("Verification not found.");
  const candidate = await getInvestigation(db, userId, projectId, row.candidate_id);
  const baseline = await latestReport(db, row.baseline_id),
    report = await latestReport(db, row.candidate_id);
  const changedFiles = JSON.parse(row.changed_files_json) as string[],
    changedTests = changedFiles.filter(testFile);
  let verdict: Verification["verdict"] = "PENDING";
  if (candidate.status === "BLOCKED" || candidate.status === "CANCELLED") verdict = "BLOCKED";
  else if (report?.status === "FAILED") verdict = "FAILED";
  else if (report?.status === "SUCCEEDED")
    verdict = changedTests.length
      ? "REVIEW_TEST_CHANGES"
      : changedFiles.length
        ? "PASSED"
        : "INCONCLUSIVE";
  const limitations = JSON.parse(row.limitations_json) as string[];
  if (report?.coverage?.omittedTests)
    limitations.push(
      `${report.coverage.omittedTests} related test file(s) were outside the execution budget.`,
    );
  return {
    id: row.id,
    baselineId: row.baseline_id,
    candidateId: row.candidate_id,
    candidateCommit: row.candidate_commit,
    verdict,
    changedTests,
    limitations,
    summary:
      verdict === "PASSED"
        ? "The retained reproducer and selected regression checks pass against the candidate."
        : verdict === "REVIEW_TEST_CHANGES"
          ? "The candidate passes, but test or fixture changes require review before treating this as a repaired behavior."
          : verdict === "FAILED"
            ? "The candidate still fails an executed check."
            : verdict === "INCONCLUSIVE"
              ? "The test passed without a recorded file change; this does not establish a source repair."
              : candidate.finding.summary,
    metrics: {
      baselineDurationMs: baseline?.durationMs ?? null,
      candidateDurationMs: report?.durationMs ?? null,
      evidenceChars: report ? JSON.stringify(report).length : 0,
      providerCalls: null,
      agentTokens: null,
    },
  };
}
export async function createVerification(
  env: Env,
  userId: string,
  projectId: string,
  baselineId: string,
  commit: string,
  requestKey?: string,
  fetcher: typeof fetch = fetch,
) {
  const baseline = await getInvestigation(env.DB, userId, projectId, baselineId),
    report = await latestReport(env.DB, baselineId);
  if (!report || report.status !== "FAILED" || !report.commit || !report.command.testPath)
    throw badRequest(
      "BASELINE_REPRODUCER_REQUIRED",
      "Verification needs a recorded failing test with a known source commit.",
    );
  const key = requestKey ?? `${baselineId}-${commit}`;
  const previous = await env.DB.prepare(
    "SELECT id,candidate_commit,baseline_id FROM investigation_verifications WHERE project_id=? AND request_key=?",
  )
    .bind(projectId, key)
    .first<{ id: string; candidate_commit: string; baseline_id: string }>();
  if (previous) {
    if (previous.candidate_commit !== commit || previous.baseline_id !== baselineId)
      throw conflict(
        "VERIFICATION_REQUEST_REUSED",
        "This key belongs to a different verification.",
      );
    return getVerification(env.DB, userId, projectId, previous.id);
  }
  const repo = await env.DB.prepare(
    "SELECT full_name,installation_id FROM project_repositories WHERE project_id=?",
  )
    .bind(projectId)
    .first<{ full_name: string; installation_id: number | null }>();
  if (!repo?.installation_id)
    throw badRequest(
      "REPOSITORY_ACCESS_REQUIRED",
      "Connect GitHub repository access to verify a candidate commit.",
    );
  const comparison = await githubRequest<{
    status: string;
    files?: { filename: string; status: string }[];
  }>(
    env,
    repo.installation_id,
    `/repos/${repo.full_name}/compare/${report.commit}...${commit}`,
    {},
    fetcher,
  );
  if (!["ahead", "identical"].includes(comparison.status))
    throw badRequest(
      "CANDIDATE_ANCESTRY_UNSUPPORTED",
      "This verification requires a candidate derived from the recorded baseline revision.",
    );
  const changed = (comparison.files ?? []).map((f) => f.filename),
    limitations = [
      "Verification covers recorded checks, not every application behavior.",
      "Provider calls and coding-agent token consumption are unknown unless separately measured.",
    ];
  if (changed.length >= 300) limitations.push("GitHub's changed-file response may be truncated.");
  const candidate = await createInvestigation(
    env.DB,
    userId,
    projectId,
    investigationRequestSchema.parse({
      question: baseline.question,
      requestKey: "candidate-" + (await sha256Hex(projectId + ":" + key)),
    }),
    {
      repository: repo.full_name,
      commit,
      filesScanned: 0,
      warnings: ["The candidate will be indexed by its executor."],
    },
  );
  const id = randomId("ver");
  await env.DB.prepare(
    "INSERT INTO investigation_verifications(id,project_id,baseline_id,candidate_id,request_key,candidate_commit,changed_files_json,limitations_json,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,request_key) DO NOTHING",
  )
    .bind(
      id,
      projectId,
      baselineId,
      candidate.id,
      key,
      commit,
      JSON.stringify(changed),
      JSON.stringify(limitations),
      nowIso(),
    )
    .run();
  const retained = await env.DB.prepare(
    "SELECT id FROM investigation_verifications WHERE project_id=? AND request_key=?",
  )
    .bind(projectId, key)
    .first<{ id: string }>();
  const capture = await env.DB.prepare(
    "SELECT id FROM investigation_recordings WHERE investigation_id=? AND project_id=? AND request_id=? AND eligible=1 LIMIT 1",
  )
    .bind(baselineId, projectId, report.requestId)
    .first<{ id: string }>();
  const recording = capture ? await getRecording(env.DB, userId, projectId, capture.id) : null;
  await startInvestigationExecution(
    env,
    userId,
    projectId,
    candidate.id,
    {
      initial: true,
      testPath: report.command.testPath,
      changedFiles: changed.slice(0, 100),
      ...(recording ? { replayRecording: { id: recording.id, manifest: recording.manifest } } : {}),
    },
    fetcher,
  );
  return getVerification(env.DB, userId, projectId, retained!.id);
}
