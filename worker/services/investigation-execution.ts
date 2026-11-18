import { cancelRepositoryCheck } from "../repositories/cancel-check";
import type {
  InvestigationPlan,
  InvestigationReport,
} from "../../shared/contracts/investigation-execution";
import { redact } from "../../shared/contracts/traces";
import { ApiError, badRequest, conflict, notFound } from "../api/errors";
import { dispatchRepositoryChecks } from "../repositories/checks";
import { githubRequest } from "../repositories/github";
import { getInvestigation, createInvestigation } from "./investigation-service";
import { getRecording } from "./recording-service";
import type { InvestigationRequest } from "../../shared/contracts/investigations";
export async function beginInvestigation(
  env: Env,
  userId: string,
  projectId: string,
  request: InvestigationRequest,
  fetcher: typeof fetch = fetch,
) {
  if (request.commit) {
    if (request.mode !== "execute" || request.target.kind !== "source") {
      throw badRequest(
        "COMMIT_SELECTION_UNSUPPORTED",
        "Explicit commit selection is supported for source-targeted execute investigations.",
      );
    }
    const repo = await env.DB.prepare(
      "SELECT full_name,installation_id FROM project_repositories WHERE project_id=?",
    )
      .bind(projectId)
      .first<{ full_name: string; installation_id: number | null }>();
    if (!repo?.installation_id || !repo.full_name) {
      throw badRequest(
        "REPOSITORY_ACCESS_REQUIRED",
        "Connect GitHub repository access to execute an explicit commit revision.",
      );
    }
    let validatedCommit: string;
    try {
      const commitData = await githubRequest<{ sha: string }>(
        env,
        repo.installation_id,
        `/repos/${repo.full_name}/commits/${encodeURIComponent(request.commit)}`,
        {},
        fetcher,
      );
      if (!commitData?.sha || commitData.sha.toLowerCase() !== request.commit.toLowerCase()) {
        throw notFound("The selected commit was not found in the connected repository.");
      }
      validatedCommit = commitData.sha;
    } catch (error) {
      if (error instanceof ApiError) {
        const ghStatus = (error.details as { githubStatus?: number } | undefined)?.githubStatus;
        if (ghStatus === 404 || error.status === 404) {
          throw notFound("The selected commit was not found in the connected repository.");
        }
        if (ghStatus !== undefined) {
          throw badRequest(
            "COMMIT_INACCESSIBLE",
            "The selected commit is inaccessible through the connected repository installation.",
            { githubStatus: ghStatus },
          );
        }
      }
      throw error;
    }
    const inv = await createInvestigation(
      env.DB,
      userId,
      projectId,
      request,
      {
        repository: repo.full_name,
        commit: validatedCommit,
        filesScanned: 0,
        warnings: ["The selected revision will be indexed by its executor."],
      },
    );
    return startInvestigationExecution(
      env,
      userId,
      projectId,
      inv.id,
      {
        initial: true,
        testPath: request.testPath,
        captureInteractions: request.captureInteractions,
      },
      fetcher,
    );
  }
  const recording =
    request.mode === "replay" && request.recordingId
      ? await getRecording(env.DB, userId, projectId, request.recordingId)
      : null;
  if (request.mode === "replay" && (!recording?.eligible || !recording.manifest.sourceCommit))
    throw conflict(
      "REPLAY_UNAVAILABLE",
      "Select a complete eligible recording with a known source revision.",
    );
  const repo = recording
    ? await env.DB.prepare("SELECT full_name FROM project_repositories WHERE project_id=?")
        .bind(projectId)
        .first<{ full_name: string }>()
    : null;
  const inv = await createInvestigation(
    env.DB,
    userId,
    projectId,
    request,
    recording
      ? {
          repository: repo?.full_name ?? null,
          commit: recording.manifest.sourceCommit,
          filesScanned: 0,
          warnings: ["Replay uses retained JSON fetch interactions in an isolated runtime."],
        }
      : undefined,
  );
  return request.mode === "analyze"
    ? inv
    : startInvestigationExecution(
        env,
        userId,
        projectId,
        inv.id,
        {
          initial: true,
          testPath: request.testPath ?? recording?.manifest.testPath,
          captureInteractions: request.captureInteractions,
          replayRecording: recording
            ? { id: recording.id, manifest: recording.manifest }
            : undefined,
        },
        fetcher,
      );
}
import { randomId } from "../lib/crypto";
import { nowIso } from "../lib/time";

export async function startInvestigationExecution(
  env: Env,
  userId: string,
  projectId: string,
  id: string,
  options: {
    testPath?: string;
    initial?: boolean;
    changedFiles?: string[];
    captureInteractions?: boolean;
    replayRecording?: InvestigationPlan["replayRecording"];
  } = {},
  fetcher: typeof fetch = fetch,
) {
  const inv = await getInvestigation(env.DB, userId, projectId, id);
  const attempts = await env.DB.prepare(
    "SELECT id FROM investigation_attempts WHERE investigation_id=?",
  )
    .bind(id)
    .all();
  if (inv.status === "EXECUTING" || (options.initial && attempts.results.length)) return inv;
  if (inv.status === "CANCELLED")
    throw conflict("INVESTIGATION_CANCELLED", "Start a new investigation after cancellation.");
  if (attempts.results.length >= 3)
    throw conflict(
      "INVESTIGATION_ATTEMPT_LIMIT",
      "This investigation reached its three-attempt budget. Its evidence remains available.",
    );
  const claim = await env.DB.prepare(
    "UPDATE investigations SET status='EXECUTING',updated_at=? WHERE id=? AND project_id=? AND status IN ('EVIDENCE_READY','BLOCKED') RETURNING id",
  )
    .bind(nowIso(), id, projectId)
    .first();
  if (!claim) return getInvestigation(env.DB, userId, projectId, id);
  const requestId = randomId("req"),
    attemptId = randomId("iat"),
    at = nowIso();
  const plan: InvestigationPlan = {
    investigationId: id,
    requestId,
    question: inv.question,
    ...(options.testPath ? { testPath: options.testPath } : {}),
    ...(options.changedFiles ? { changedFiles: options.changedFiles, maxTestFiles: 3 } : {}),
    ...(options.captureInteractions ? { captureInteractions: true } : {}),
    ...(options.replayRecording ? { replayRecording: options.replayRecording } : {}),
    commit: inv.snapshot.commit,
    timeoutMs: 120000,
  };
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO investigation_attempts(id,investigation_id,request_id,plan_json,status,created_at,updated_at) VALUES(?,?,?,?,'QUEUED',?,?)",
      ).bind(attemptId, id, requestId, JSON.stringify(plan), at, at),
      env.DB.prepare(
        "INSERT INTO repository_check_requests(id,project_id,snapshot_json,created_at) VALUES(?,?,?,?)",
      ).bind(
        requestId,
        projectId,
        JSON.stringify({
          config: { directory: ".", startScript: "", port: 3000 },
          cases: [],
          investigation: plan,
        }),
        at,
      ),
    ]);
    const check = await dispatchRepositoryChecks(
      env,
      projectId,
      fetcher,
      requestId,
      "investigation:" + requestId,
    );
    await env.DB.prepare("UPDATE investigation_attempts SET check_id=?,updated_at=? WHERE id=?")
      .bind(check.id, nowIso(), attemptId)
      .run();
    if (check.state === "UNKNOWN")
      await env.DB.prepare(
        "UPDATE investigations SET status='BLOCKED',finding_json=?,updated_at=? WHERE id=?",
      )
        .bind(
          JSON.stringify({
            summary:
              "The executor did not confirm launch. Traceyard will not launch duplicate work automatically.",
            basis: "observed",
            limitations: ["Execution outcome is unconfirmed."],
            nextAction: "Inspect the associated repository check.",
          }),
          nowIso(),
          id,
        )
        .run();
  } catch (error) {
    const summary =
      error instanceof ApiError
        ? error.message
        : "The investigation executor is unavailable. Source evidence remains available.";
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE investigation_attempts SET status='BLOCKED',updated_at=? WHERE id=?",
      ).bind(nowIso(), attemptId),
      env.DB.prepare(
        "UPDATE investigations SET status='BLOCKED',finding_json=?,updated_at=? WHERE id=?",
      ).bind(
        JSON.stringify({
          summary,
          basis: "observed",
          limitations: ["The selected test has not executed."],
          nextAction:
            error instanceof ApiError && error.code === "CI_SETUP_REQUIRED"
              ? "Enable the reviewed GitHub integration inside Traceyard, then execute this investigation."
              : "Inspect execution availability and retry when ready.",
        }),
        nowIso(),
        id,
      ),
    ]);
  }
  return getInvestigation(env.DB, userId, projectId, id);
}
export async function recordInvestigationReport(
  db: D1Database,
  projectId: string,
  id: string,
  report: InvestigationReport,
) {
  const row = await db
    .prepare(
      "SELECT a.id,a.plan_json,a.report_json,a.status,r.runner_id,i.status AS investigation_status FROM investigation_attempts a JOIN investigations i ON i.id=a.investigation_id JOIN repository_check_requests r ON r.id=a.request_id AND r.project_id=i.project_id WHERE a.investigation_id=? AND a.request_id=? AND i.project_id=?",
    )
    .bind(id, report.requestId, projectId)
    .first<{
      id: string;
      plan_json: string;
      report_json: string | null;
      status: string;
      runner_id: string | null;
      investigation_status: string;
    }>();
  if (!row) throw notFound("Investigation attempt not found.");
  const plan = JSON.parse(row.plan_json) as InvestigationPlan;
  if (
    plan.replayRecording &&
    report.status === "SUCCEEDED" &&
    (!report.replay ||
      report.replay.recordingId !== plan.replayRecording.id ||
      report.replay.diverged)
  )
    throw conflict(
      "REPLAY_PROOF_REQUIRED",
      "A replay cannot claim success without matching isolated replay evidence.",
    );
  if (row.runner_id !== report.runId)
    throw conflict(
      "INVESTIGATION_RUNNER_MISMATCH",
      "This report does not belong to the authorized runner.",
    );
  if (plan.commit && plan.commit !== report.commit && report.status !== "BLOCKED")
    throw conflict(
      "INVESTIGATION_REVISION_MISMATCH",
      "The executed revision differs from the investigation snapshot.",
    );
  if (plan.testPath && report.command.testPath && plan.testPath !== report.command.testPath)
    throw conflict(
      "INVESTIGATION_TEST_MISMATCH",
      "The executed test differs from the requested test.",
    );
  const json = JSON.stringify(redact(report));
  if (row.report_json) {
    if (row.report_json !== json)
      throw conflict("INVESTIGATION_REPORT_CHANGED", "A completed attempt cannot be overwritten.");
    return;
  }
  if (row.investigation_status === "CANCELLED")
    throw conflict("INVESTIGATION_CANCELLED", "The investigation was cancelled.");
  const summary =
    report.message +
    (report.failures[0]
      ? " " + report.failures[0].name + ": " + report.failures[0].message.slice(0, 1000)
      : "");
  const finding = {
    summary: String(redact(summary)),
    basis: "observed",
    limitations: [
      ...(report.truncated
        ? ["Failure evidence was truncated; not all details are retained."]
        : []),
      "These results cover the selected test execution, not the entire application.",
    ],
    nextAction:
      report.status === "FAILED"
        ? "Inspect the failure evidence, repair the relevant code, then verify the candidate."
        : report.status === "BLOCKED"
          ? "Resolve the reported prerequisite or select an indexed test."
          : "Inspect verification coverage before drawing broader conclusions.",
  };
  const at = nowIso();
  await db.batch([
    db
      .prepare(
        "UPDATE investigation_attempts SET status=?,report_json=?,updated_at=? WHERE id=? AND report_json IS NULL AND EXISTS(SELECT 1 FROM investigations WHERE id=? AND status!='CANCELLED')",
      )
      .bind(report.status, json, at, row.id, id),
    db
      .prepare(
        "INSERT INTO investigation_evidence(id,investigation_id,kind,basis,title,content_json,truncated,created_at) SELECT ?,?,'diagnostic','observed','Focused test execution',?,?,? WHERE NOT EXISTS(SELECT 1 FROM investigation_evidence WHERE id=?) AND EXISTS(SELECT 1 FROM investigation_attempts WHERE id=? AND report_json=?)",
      )
      .bind(
        "evd_" + row.id.slice(4),
        id,
        json,
        Number(report.truncated),
        at,
        "evd_" + row.id.slice(4),
        row.id,
        json,
      ),
    db
      .prepare(
        "UPDATE investigations SET status=?,finding_json=?,updated_at=? WHERE id=? AND status!='CANCELLED' AND EXISTS(SELECT 1 FROM investigation_attempts WHERE id=? AND report_json=?)",
      )
      .bind(
        report.status === "BLOCKED" ? "BLOCKED" : "EVIDENCE_READY",
        JSON.stringify(finding),
        at,
        id,
        row.id,
        json,
      ),
  ]);
  const retained = await db
    .prepare("SELECT report_json FROM investigation_attempts WHERE id=?")
    .bind(row.id)
    .first<{ report_json: string | null }>();
  if (retained?.report_json !== json)
    throw conflict(
      "INVESTIGATION_REPORT_CHANGED",
      "The result conflicted with a completed or cancelled attempt.",
    );
}
export async function cancelInvestigation(
  db: D1Database,
  userId: string,
  projectId: string,
  id: string,
) {
  await getInvestigation(db, userId, projectId, id);
  await db.batch([
    db
      .prepare(
        "UPDATE investigations SET status='CANCELLED',updated_at=? WHERE id=? AND project_id=?",
      )
      .bind(nowIso(), id, projectId),
    db
      .prepare(
        "UPDATE investigation_attempts SET status='CANCELLED',updated_at=? WHERE investigation_id=? AND status IN ('QUEUED','RUNNING')",
      )
      .bind(nowIso(), id),
  ]);
  return getInvestigation(db, userId, projectId, id);
}

export async function cancelInvestigationExecution(
  env: Env,
  userId: string,
  projectId: string,
  id: string,
  fetcher: typeof fetch = fetch,
) {
  await cancelInvestigation(env.DB, userId, projectId, id);
  const attempt = await env.DB.prepare(
    "SELECT check_id FROM investigation_attempts WHERE investigation_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
  )
    .bind(id)
    .first<{ check_id: string | null }>();
  let limitation = "No external check was attached.";
  if (attempt?.check_id) {
    try {
      await cancelRepositoryCheck(env, userId, projectId, attempt.check_id, fetcher);
      limitation = "External cancellation was requested. The executor may take time to stop.";
    } catch {
      limitation =
        "The external executor did not confirm cancellation. Its execution timeout still applies; no late result will replace this record.";
    }
  }
  await env.DB.prepare(
    "UPDATE investigations SET finding_json=?,updated_at=? WHERE id=? AND project_id=?",
  )
    .bind(
      JSON.stringify({
        summary: "This investigation was cancelled.",
        basis: "observed",
        limitations: [limitation],
        nextAction: "Start a new investigation when ready.",
      }),
      nowIso(),
      id,
      projectId,
    )
    .run();
  return getInvestigation(env.DB, userId, projectId, id);
}
