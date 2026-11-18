import { recordingManifestSchema, type RecordingManifest } from "../../shared/contracts/recordings";
import {
  eligibleRecording,
  interactionSignature,
  sensitive,
  recordingUrl,
} from "../../agent/interaction-format.mjs";
import { getOwnedProject } from "../persistence/projects";
import { sha256Hex } from "../lib/crypto";
import { nowIso } from "../lib/time";
import { badRequest, conflict, notFound } from "../api/errors";
export async function getRecording(db: D1Database, userId: string, projectId: string, id: string) {
  if (!(await getOwnedProject(db, userId, projectId))) throw notFound("Project not found.");
  const row = await db
    .prepare(
      "SELECT id,investigation_id,manifest_json,eligible FROM investigation_recordings WHERE id=? AND project_id=?",
    )
    .bind(id, projectId)
    .first<{ id: string; investigation_id: string; manifest_json: string; eligible: number }>();
  if (!row) throw notFound("Recording not found.");
  return {
    id: row.id,
    investigationId: row.investigation_id,
    eligible: !!row.eligible,
    manifest: recordingManifestSchema.parse(JSON.parse(row.manifest_json)),
  };
}
export async function saveRecording(
  db: D1Database,
  projectId: string,
  invId: string,
  requestId: string,
  runId: string,
  manifest: RecordingManifest,
) {
  const attempt = await db
    .prepare(
      "SELECT a.plan_json,r.runner_id FROM investigation_attempts a JOIN investigations i ON i.id=a.investigation_id JOIN repository_check_requests r ON r.id=a.request_id WHERE a.investigation_id=? AND a.request_id=? AND i.project_id=?",
    )
    .bind(invId, requestId, projectId)
    .first<{ plan_json: string; runner_id: string | null }>();
  if (!attempt || attempt.runner_id !== runId)
    throw notFound("Authorized capture attempt not found.");
  const plan = JSON.parse(attempt.plan_json);
  if (!plan.captureInteractions || plan.replayRecording)
    throw badRequest(
      "CAPTURE_NOT_REQUESTED",
      "This attempt did not authorize interaction capture.",
    );
  if (plan.commit && plan.commit !== manifest.sourceCommit)
    throw conflict("RECORDING_REVISION_MISMATCH", "The recording belongs to a different revision.");
  if (plan.testPath && plan.testPath !== manifest.testPath)
    throw conflict("RECORDING_TEST_MISMATCH", "The recording belongs to a different test.");
  const json = JSON.stringify(manifest);
  if (new TextEncoder().encode(json).length > 24000 || sensitive(manifest.interactions))
    throw badRequest(
      "RECORDING_UNSAFE",
      "The recording is oversized or contains credential-bearing data.",
    );
  for (const item of manifest.interactions)
    if (
      item.url !== recordingUrl(item.url) ||
      item.signature !== (await interactionSignature(item.method, item.url, item.requestBody))
    )
      throw badRequest("RECORDING_SIGNATURE_MISMATCH", "An interaction fingerprint is invalid.");
  if (manifest.eligible !== eligibleRecording(manifest))
    throw badRequest(
      "RECORDING_ELIGIBILITY_MISMATCH",
      "This recording does not meet replay completeness requirements.",
    );
  const previous = await db
    .prepare("SELECT id,manifest_json FROM investigation_recordings WHERE request_id=?")
    .bind(requestId)
    .first<{ id: string; manifest_json: string }>();
  if (previous) {
    if (previous.manifest_json !== json)
      throw conflict("RECORDING_IMMUTABLE", "The completed recording cannot be replaced.");
    return { id: previous.id, eligible: manifest.eligible };
  }
  const id = "rcd_" + (await sha256Hex(invId + requestId)).slice(0, 32);
  await db
    .prepare(
      "INSERT INTO investigation_recordings(id,investigation_id,project_id,request_id,manifest_json,eligible,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(id, invId, projectId, requestId, json, Number(manifest.eligible), nowIso())
    .run();
  const retained = await db
    .prepare("SELECT manifest_json FROM investigation_recordings WHERE id=?")
    .bind(id)
    .first<{ manifest_json: string }>();
  if (retained?.manifest_json !== json)
    throw conflict("RECORDING_IMMUTABLE", "A concurrent recording differs from this upload.");
  return { id, eligible: manifest.eligible };
}
