import { investigationRequestSchema } from "../../shared/contracts/investigations";
import {
  investigationPlanSchema,
  type InvestigationReport,
} from "../../shared/contracts/investigation-execution";
import type { Verification, VerificationRun } from "../../shared/contracts/verification";
import { createInvestigation, getInvestigation } from "./investigation-service";
import { startInvestigationExecution } from "./investigation-execution";
import { githubRequest } from "../repositories/github";
import { badRequest, conflict, notFound } from "../api/errors";
import { randomId, sha256Hex } from "../lib/crypto";
import { getRecording } from "./recording-service";
import { nowIso } from "../lib/time";
import { managedChecksAvailable } from "../repositories/managed";
const testFile = (p: string) =>
  /\.(?:test|spec|fixture)\.[cm]?[jt]sx?$|(?:^|\/)(?:__(?:tests|fixtures|snapshots|mocks)__|tests?|fixtures?)\/|\.snap$/i.test(
    p,
  );

const testEnvironmentFile = (path: string) =>
  /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|\.npmrc|\.babelrc(?:\..+)?|tsconfig[^/]*\.json|(?:vite|vitest|jest|babel)\.(?:config|workspace)\.[^/]+|(?:setupTests|(?:vite|vitest|jest)\.setup)\.[^/]+)$/i.test(
    path,
  );

export async function startFlakinessCheck(
  env: Env,
  userId: string,
  projectId: string,
  baselineId: string,
  candidate: string,
  testPath: string,
  fetcher: typeof fetch,
) {
  const baseline = await getInvestigation(env.DB, userId, projectId, baselineId);
  if (!baseline.snapshot.commit || baseline.execution?.flakeRuns || baseline.status === "EXECUTING")
    throw badRequest(
      "FLAKE_BASELINE_REQUIRED",
      "Select a completed run at the failing commit before checking for flakiness.",
    );
  if (managedChecksAvailable(env))
    throw badRequest(
      "FLAKE_HOSTED_ONLY",
      "Flakiness checks currently require the GitHub Actions runner.",
    );
  if (baseline.execution?.command.testPath !== testPath)
    throw badRequest("FLAKE_TEST_MISMATCH", "Select the same test file used in the baseline run.");
  const repo = await env.DB.prepare(
    "SELECT full_name,installation_id FROM project_repositories WHERE project_id=?",
  )
    .bind(projectId)
    .first<{ full_name: string; installation_id: number | null }>();
  if (!repo?.installation_id)
    throw badRequest("REPOSITORY_ACCESS_REQUIRED", "Connect the GitHub repository first.");
  const revision = await githubRequest<{ sha: string }>(
    env,
    repo.installation_id,
    `/repos/${repo.full_name}/commits/${candidate}`,
    {},
    fetcher,
  );
  if (revision.sha !== candidate)
    throw notFound("The candidate commit was not found in the connected repository.");
  const existing = await env.DB.prepare(
    `SELECT i.id FROM investigations i JOIN investigation_attempts a ON a.investigation_id=i.id
     WHERE i.project_id=? AND i.owner_user_id=? AND i.status='EXECUTING' AND json_extract(a.plan_json,'$.flakeCandidate') IS NOT NULL LIMIT 1`,
  )
    .bind(projectId, userId)
    .first<{ id: string }>();
  if (existing)
    throw conflict(
      "FLAKE_ALREADY_RUNNING",
      "A flakiness check is already running. Open Recent investigations to follow it.",
    );
  const slot = Math.floor(Date.now() / 15000);
  const key = await sha256Hex(
    [baselineId, baseline.snapshot.commit, candidate, testPath, slot].join(":"),
  );
  const inv = await createInvestigation(
    env.DB,
    userId,
    projectId,
    investigationRequestSchema.parse({
      question: `Check for flakiness in ${testPath}`,
      requestKey: `flake-${key}`,
    }),
    baseline.snapshot,
  );
  return startInvestigationExecution(
    env,
    userId,
    projectId,
    inv.id,
    { initial: true, testPath, flakeCandidate: candidate },
    fetcher,
  );
}
type Attempt = { id: string; status: string; report_json: string | null };
async function firstCandidateAttempt(db: D1Database, id: string) {
  return db
    .prepare(
      "SELECT id,status,report_json FROM investigation_attempts WHERE investigation_id=? ORDER BY rowid LIMIT 1",
    )
    .bind(id)
    .first<Attempt>();
}
async function baselineAttempt(
  db: D1Database,
  id: string,
  requestId: string | null,
  before: string,
) {
  const row = await db
    .prepare(
      `SELECT id,status,report_json FROM investigation_attempts WHERE investigation_id=? AND
       (request_id=? OR (? IS NULL AND status='FAILED' AND created_at<=?)) ORDER BY rowid DESC LIMIT 1`,
    )
    .bind(id, requestId, requestId, before)
    .first<Attempt>();
  return row;
}
function readReport(attempt: Attempt | null): InvestigationReport | null {
  return attempt?.report_json ? (JSON.parse(attempt.report_json) as InvestigationReport) : null;
}
function runEvidence(
  attempt: Attempt | null,
  report: InvestigationReport | null,
): VerificationRun | null {
  if (!attempt || !report?.commit || !report.command.testPath || report.flakeRuns) return null;
  return {
    commit: report.commit,
    testPath: report.command.testPath,
    status:
      report.checks?.find((check) => check.testPath === report.command.testPath)?.status ??
      report.status,
    evidenceId: "evd_" + attempt.id.slice(4),
    failure: report.failures.find((failure) => failure.file === report.command.testPath) ?? null,
  };
}
async function compareTrees(
  env: Env,
  installationId: number,
  repository: string,
  baseline: string,
  candidate: string,
  fetcher: typeof fetch,
) {
  // GitHub's normal comparison reports changes from the merge base. A PR head and a
  // previous synthetic merge commit need a comparison of the two executed trees instead.
  async function tree(commit: string) {
    const revision = await githubRequest<{ tree: { sha: string } }>(
      env,
      installationId,
      `/repos/${repository}/git/commits/${commit}`,
      {},
      fetcher,
    );
    return githubRequest<{
      truncated: boolean;
      tree: { path: string; mode: string; type: string; sha: string }[];
    }>(
      env,
      installationId,
      `/repos/${repository}/git/trees/${revision.tree.sha}?recursive=1`,
      {},
      fetcher,
    );
  }
  const [before, after] = await Promise.all([tree(baseline), tree(candidate)]);
  if (before.truncated || after.truncated) return { changed: [], incomplete: true };
  const entries = (value: typeof before) =>
    new Map(
      value.tree
        .filter((file) => file.type !== "tree")
        .map((file) => [file.path, `${file.mode}:${file.sha}`]),
    );
  const left = entries(before),
    right = entries(after);
  const changed = [...new Set([...left.keys(), ...right.keys()])].filter(
    (path) => left.get(path) !== right.get(path),
  );
  return { changed: changed.slice(0, 1000), incomplete: changed.length > 1000 };
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
      baseline_request_id: string | null;
      comparison_incomplete: number;
      created_at: string;
    }>();
  if (!row) throw notFound("Verification not found.");
  const candidate = await getInvestigation(db, userId, projectId, row.candidate_id);
  const [original, rerun] = await Promise.all([
    baselineAttempt(db, row.baseline_id, row.baseline_request_id, row.created_at),
    firstCandidateAttempt(db, row.candidate_id),
  ]);
  const baseline = readReport(original),
    report = readReport(rerun),
    baselineRun = runEvidence(original, baseline),
    candidateRun = runEvidence(rerun, report),
    originalTest = report?.originalTest;
  const changedFiles = JSON.parse(row.changed_files_json) as string[],
    changedTests = changedFiles.filter(testFile);
  let verdict: Verification["verdict"] = "PENDING";
  let label: Verification["label"] = "Running";
  let summary = "Waiting for the candidate run. Its result will appear here.";
  const comparisonIncomplete =
    !!row.comparison_incomplete || (!row.baseline_request_id && changedFiles.length >= 300);
  if (!baselineRun?.failure || !baseline?.counts.failed || baselineRun.status !== "FAILED") {
    verdict = "INCONCLUSIVE";
    label = "Inconclusive";
    summary =
      "The original assertion failure was not reproduced. Check the failing commit and test file.";
  } else if (
    rerun?.status === "BLOCKED" ||
    rerun?.status === "CANCELLED" ||
    (!rerun && ["BLOCKED", "CANCELLED"].includes(candidate.status))
  ) {
    verdict = "BLOCKED";
    label = "Inconclusive";
    summary = report?.message ?? candidate.finding.summary;
  } else if (report) {
    verdict = "INCONCLUSIVE";
    label = "Inconclusive";
    if (
      candidateRun?.testPath !== baselineRun.testPath ||
      candidateRun.commit !== row.candidate_commit
    ) {
      summary =
        "The candidate did not report the same test file at the selected commit. Check its execution evidence.";
    } else if (candidateRun.status === "FAILED" && candidateRun.failure && report.counts.failed) {
      verdict = "FAILED";
      label = "Still failing";
      summary =
        candidateRun.failure.name === baselineRun.failure.name
          ? "The candidate still fails the original test case. Compare the recorded assertions below."
          : "The same test file fails on the candidate, with a different recorded test case.";
    } else if (
      candidateRun.status !== "SUCCEEDED" ||
      !report.counts.passed ||
      report.counts.skipped > (baseline.counts.skipped ?? 0)
    ) {
      summary =
        "The candidate run did not establish a pass of the recorded check. Review the test output and any skipped tests.";
    } else if (comparisonIncomplete) {
      summary =
        "The recorded check passed, but the changed-file comparison is incomplete. Review the test and fixture diff before relying on the result.";
    } else if (!changedFiles.length || candidateRun.commit === baselineRun.commit) {
      summary =
        "The check passed with no recorded file changes between runs. The evidence is inconclusive. Rerun the check under the same conditions.";
    } else if (changedFiles.some(testEnvironmentFile)) {
      summary =
        "The candidate passed, but its test configuration or dependencies changed. The original failure could not be checked under comparable conditions.";
    } else if (changedTests.length && originalTest) {
      if (
        originalTest.assertion === "FAILED" &&
        originalTest.failures.some((failure) => failure.name === baselineRun.failure?.name)
      ) {
        verdict = "FAILED";
        label = "Still failing";
        summary =
          "The candidate’s tests passed, but the original assertion still fails against the candidate’s code.";
      } else if (
        originalTest.status === "SUCCEEDED" &&
        originalTest.assertion === "PASSED" &&
        originalTest.counts.passed >= baseline.counts.passed + baseline.counts.failed &&
        originalTest.counts.skipped <= baseline.counts.skipped &&
        changedFiles.some((path) => !testFile(path))
      ) {
        verdict = "PASSED";
        label = "Confirmed";
        summary =
          "Both the candidate’s tests and the original tests passed against the candidate’s code. This result covers the recorded test file.";
      } else {
        summary =
          originalTest.status === "BLOCKED"
            ? "The candidate’s tests passed, but the original tests could not run against its code. Review the recorded reason."
            : "The candidate’s tests passed, but the original run did not establish that the code change fixed the recorded failure. Review both results.";
      }
    } else if (changedTests.length) {
      verdict = "REVIEW_TEST_CHANGES";
      label = "Passed with test changes";
      summary =
        "The recorded check passed with changed tests or fixtures. The original-test result is unavailable. Review the changed paths before relying on the result.";
    } else {
      verdict = "PASSED";
      label = "Confirmed";
      summary =
        "The baseline reproduced the failure and the same test file passed at the candidate commit. The comparison found no changed tests or fixtures. This result covers the recorded conditions.";
    }
  }
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
    label,
    baselineRun,
    candidateRun,
    ...(originalTest ? { originalTest } : {}),
    changedTests,
    limitations,
    summary,
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
  const baseline = await getInvestigation(env.DB, userId, projectId, baselineId);
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
  const original = await env.DB.prepare(
    "SELECT id,status,report_json FROM investigation_attempts WHERE investigation_id=? ORDER BY rowid DESC LIMIT 1",
  )
    .bind(baselineId)
    .first<Attempt>();
  const report = readReport(original);
  const originalRun = runEvidence(original, report);
  if (
    !report?.commit ||
    !report.command.testPath ||
    originalRun?.status !== "FAILED" ||
    !report.counts.failed ||
    !originalRun.failure
  )
    throw badRequest(
      "BASELINE_REPRODUCER_REQUIRED",
      "Inconclusive: the original assertion failure was not reproduced. Run the test file at the failing commit before verifying a candidate.",
    );
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
    merge_base_commit?: { sha: string };
    files?: { filename: string; previous_filename?: string }[];
  }>(
    env,
    repo.installation_id,
    `/repos/${repo.full_name}/compare/${report.commit}...${commit}`,
    {},
    fetcher,
  );
  if (!["ahead", "identical"].includes(comparison.status) && !comparison.merge_base_commit?.sha)
    throw badRequest(
      "CANDIDATE_ANCESTRY_UNSUPPORTED",
      "This verification requires a candidate derived from the recorded baseline revision.",
    );
  const directComparison = ["ahead", "identical"].includes(comparison.status);
  const compared = directComparison
    ? {
        changed: [
          ...new Set(
            (comparison.files ?? []).flatMap((f) =>
              f.previous_filename ? [f.previous_filename, f.filename] : [f.filename],
            ),
          ),
        ],
        incomplete:
          comparison.status !== "identical" &&
          (!comparison.files || comparison.files.length >= 300),
      }
    : await compareTrees(env, repo.installation_id, repo.full_name, report.commit, commit, fetcher);
  const changed = compared.changed;
  const limitations = ["Verification covers the recorded test file and execution conditions."];
  if (compared.incomplete)
    limitations.push("GitHub did not return a complete changed-file comparison.");
  const changedTests = changed.filter(testFile);
  const originalTest = investigationPlanSchema.shape.originalTest.safeParse({
    baselineCommit: report.commit,
    assertionName: originalRun.failure.name,
    paths: [...new Set([report.command.testPath, ...changedTests])],
  });
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
    "INSERT INTO investigation_verifications(id,project_id,baseline_id,candidate_id,request_key,candidate_commit,changed_files_json,limitations_json,created_at,baseline_request_id,comparison_incomplete) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,request_key) DO NOTHING",
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
      report.requestId,
      Number(compared.incomplete),
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
      ...(!compared.incomplete &&
      changedTests.length &&
      !changed.some(testEnvironmentFile) &&
      originalTest.success &&
      !recording &&
      !managedChecksAvailable(env)
        ? { originalTest: originalTest.data }
        : {}),
      ...(recording ? { replayRecording: { id: recording.id, manifest: recording.manifest } } : {}),
    },
    fetcher,
  );
  return getVerification(env.DB, userId, projectId, retained!.id);
}
