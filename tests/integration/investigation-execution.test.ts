import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import { createInvestigation, getInvestigation } from "../../worker/services/investigation-service";
import {
  startInvestigationExecution,
  recordInvestigationReport,
  cancelInvestigation,
} from "../../worker/services/investigation-execution";
import { investigationRequestSchema } from "../../shared/contracts/investigations";
import type { InvestigationReport } from "../../shared/contracts/investigation-execution";
import { saveRecording, getRecording } from "../../worker/services/recording-service";
import { interactionSignature } from "../../agent/interaction-format.mjs";
import type { RecordingManifest } from "../../shared/contracts/recordings";
import { ORIGIN } from "./helpers";
async function setup() {
  const user = await getOrCreateGitHubIdentity(env.DB, {
    id: 970,
    login: "execution-owner",
    name: "Owner",
    avatarUrl: null,
  });
  await createUserSession(env.DB, user.id, new Request(ORIGIN));
  const projectId = (await getDefaultProjectId(env.DB, user.id))!;
  const inv = await createInvestigation(
    env.DB,
    user.id,
    projectId,
    investigationRequestSchema.parse({ question: "Investigate the existing tests" }),
  );
  return { userId: user.id, projectId, inv };
}
async function seed(a: Awaited<ReturnType<typeof setup>>) {
  const requestId = "req_" + "b".repeat(32),
    at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO repository_check_requests(id,project_id,snapshot_json,runner_id,created_at) VALUES(?,?,'{}','local-fixture',?)",
  )
    .bind(requestId, a.projectId, at)
    .run();
  await env.DB.prepare(
    "INSERT INTO investigation_attempts(id,investigation_id,request_id,plan_json,status,created_at,updated_at) VALUES(?,?,?,?,'RUNNING',?,?)",
  )
    .bind(
      "iat_" + "c".repeat(32),
      a.inv.id,
      requestId,
      JSON.stringify({ commit: "a".repeat(40), testPath: "test/actual.test.ts" }),
      at,
      at,
    )
    .run();
  const report: InvestigationReport = {
    requestId,
    runId: "local-fixture",
    commit: "a".repeat(40),
    status: "FAILED",
    command: { directory: ".", script: "test", testPath: "test/actual.test.ts" },
    counts: { passed: 2, failed: 1, skipped: 0 },
    failures: [
      {
        file: "test/actual.test.ts",
        name: "preserves context",
        message: "Expected canonical context",
      },
    ],
    message: "2 passed, 1 failed",
    durationMs: 500,
    exitCode: 1,
    truncated: false,
    nodeVersion: "v22.0.0",
  };
  return report;
}
describe("investigation execution lifecycle", () => {
  it("preserves source evidence when executor setup is unavailable and deduplicates initial execution", async () => {
    const a = await setup();
    const blocked = await startInvestigationExecution(env, a.userId, a.projectId, a.inv.id, {
      initial: true,
    });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.evidence.length).toBeGreaterThan(0);
    const again = await startInvestigationExecution(env, a.userId, a.projectId, a.inv.id, {
      initial: true,
    });
    expect(again.attempts).toHaveLength(1);
  });
  it("attaches real report-shaped evidence while rejecting another runner, revision or changed result", async () => {
    const a = await setup(),
      report = await seed(a);
    await expect(
      recordInvestigationReport(env.DB, a.projectId, a.inv.id, { ...report, runId: "other" }),
    ).rejects.toThrow("authorized runner");
    await expect(
      recordInvestigationReport(env.DB, a.projectId, a.inv.id, {
        ...report,
        commit: "d".repeat(40),
      }),
    ).rejects.toThrow("revision");
    await recordInvestigationReport(env.DB, a.projectId, a.inv.id, report);
    await recordInvestigationReport(env.DB, a.projectId, a.inv.id, report);
    const inv = await getInvestigation(env.DB, a.userId, a.projectId, a.inv.id);
    expect(inv.status).toBe("EVIDENCE_READY");
    expect(inv.finding.summary).toContain("preserves context");
    expect(inv.evidence.filter((e) => e.kind === "diagnostic")).toHaveLength(1);
    await expect(
      recordInvestigationReport(env.DB, a.projectId, a.inv.id, {
        ...report,
        message: "Replaced history",
      }),
    ).rejects.toThrow("overwritten");
  });
  it("keeps cancellation terminal when a late executor result arrives", async () => {
    const a = await setup(),
      report = await seed(a);
    await cancelInvestigation(env.DB, a.userId, a.projectId, a.inv.id);
    await expect(recordInvestigationReport(env.DB, a.projectId, a.inv.id, report)).rejects.toThrow(
      "cancelled",
    );
    expect((await getInvestigation(env.DB, a.userId, a.projectId, a.inv.id)).status).toBe(
      "CANCELLED",
    );
  });
});

describe("interaction recordings", () => {
  it("binds captures to the authorized runner and keeps manifests immutable and scoped", async () => {
    const a = await setup(),
      report = await seed(a);
    const item = {
      method: "GET",
      url: "https://api.example/value",
      requestBody: null,
      response: { status: 200, body: { value: 42 } },
      signature: await interactionSignature("GET", "https://api.example/value", null),
    };
    const manifest: RecordingManifest = {
      schemaVersion: 1,
      kind: "json-fetch",
      sourceCommit: report.commit,
      testPath: report.command.testPath!,
      interactions: [item],
      environment: [],
      omissions: [],
      eligible: true,
    };
    await expect(
      saveRecording(env.DB, a.projectId, a.inv.id, report.requestId, report.runId, manifest),
    ).rejects.toThrow("authorize interaction capture");
    await env.DB.prepare("UPDATE investigation_attempts SET plan_json=? WHERE request_id=?")
      .bind(
        JSON.stringify({
          commit: report.commit,
          testPath: manifest.testPath,
          captureInteractions: true,
        }),
        report.requestId,
      )
      .run();
    await expect(
      saveRecording(env.DB, a.projectId, a.inv.id, report.requestId, "another-runner", manifest),
    ).rejects.toThrow("Authorized capture");
    const saved = await saveRecording(
      env.DB,
      a.projectId,
      a.inv.id,
      report.requestId,
      report.runId,
      manifest,
    );
    expect((await getRecording(env.DB, a.userId, a.projectId, saved.id)).manifest).toEqual(
      manifest,
    );
    await expect(getRecording(env.DB, "another-user", a.projectId, saved.id)).rejects.toThrow(
      "not found",
    );
    await expect(
      saveRecording(env.DB, a.projectId, a.inv.id, report.requestId, report.runId, {
        ...manifest,
        environment: [{ name: "EXAMPLE_API_KEY", kind: "credential" }],
      }),
    ).rejects.toThrow("cannot be replaced");
    await expect(
      saveRecording(env.DB, a.projectId, a.inv.id, report.requestId, report.runId, {
        ...manifest,
        sourceCommit: "d".repeat(40),
      }),
    ).rejects.toThrow("revision");
  });
  it("rejects a successful replay result without isolated recording proof", async () => {
    const a = await setup(),
      report = await seed(a);
    await env.DB.prepare("UPDATE investigation_attempts SET plan_json=? WHERE request_id=?")
      .bind(
        JSON.stringify({ commit: report.commit, replayRecording: { id: "rcd_required" } }),
        report.requestId,
      )
      .run();
    await expect(
      recordInvestigationReport(env.DB, a.projectId, a.inv.id, {
        ...report,
        status: "SUCCEEDED",
        counts: { passed: 1, failed: 0, skipped: 0 },
        failures: [],
        exitCode: 0,
      }),
    ).rejects.toThrow("isolated replay evidence");
  });
});
