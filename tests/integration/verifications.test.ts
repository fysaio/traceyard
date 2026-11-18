import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:workers";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import { createInvestigation, getInvestigation } from "../../worker/services/investigation-service";
import { createVerification, getVerification } from "../../worker/services/verification-service";
import { recordInvestigationReport } from "../../worker/services/investigation-execution";
import { investigationRequestSchema } from "../../shared/contracts/investigations";
import type { InvestigationReport } from "../../shared/contracts/investigation-execution";
import { ORIGIN } from "./helpers";
let configured: Env;
beforeAll(async () => {
  const key = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  configured = {
    ...env,
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "traceyard",
    GITHUB_APP_WEBHOOK_SECRET: "fixture",
    GITHUB_APP_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\n" +
      btoa(
        String.fromCharCode(
          ...new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey)),
        ),
      ) +
      "\n-----END PRIVATE KEY-----",
  };
});
async function fixture() {
  const user = await getOrCreateGitHubIdentity(env.DB, {
    id: 960,
    login: "verify-owner",
    name: "Owner",
    avatarUrl: null,
  });
  await createUserSession(env.DB, user.id, new Request(ORIGIN));
  const projectId = (await getDefaultProjectId(env.DB, user.id))!,
    at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO github_installations(id,account_id,account_login,updated_at) VALUES(9,'960','verify-owner',?)",
  )
    .bind(at)
    .run();
  await env.DB.prepare(
    "INSERT INTO project_repositories(project_id,repository_id,installation_id,full_name,default_branch,status,commit_sha,scan_json,updated_at) VALUES(?,9,9,'verify-owner/app','main','DISCOVERED',?,'{}',?)",
  )
    .bind(projectId, "a".repeat(40), at)
    .run();
  const baseline = await createInvestigation(
    env.DB,
    user.id,
    projectId,
    investigationRequestSchema.parse({ question: "Investigate sum" }),
  );
  const report: InvestigationReport = {
    requestId: "req_" + "a".repeat(32),
    runId: "local-baseline",
    commit: "a".repeat(40),
    status: "FAILED",
    command: { directory: ".", script: "test", testPath: "sum.test.ts" },
    counts: { passed: 0, failed: 1, skipped: 0 },
    failures: [{ file: "sum.test.ts", name: "adds", message: "Expected 3, received -1" }],
    message: "One failed test",
    durationMs: 200,
    exitCode: 1,
    truncated: false,
    nodeVersion: "v22",
  };
  await env.DB.prepare(
    "INSERT INTO investigation_attempts(id,investigation_id,request_id,plan_json,status,report_json,created_at,updated_at) VALUES(?,?,?,'{}','FAILED',?,?,?)",
  )
    .bind("iat_" + "a".repeat(32), baseline.id, report.requestId, JSON.stringify(report), at, at)
    .run();
  return { userId: user.id, projectId, baseline, report };
}
function github(files: string[], status = "ahead"): typeof fetch {
  return async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/access_tokens")) return Response.json({ token: "fixture" });
    if (path.includes("/compare/"))
      return Response.json({
        status,
        files: files.map((filename) => ({ filename, status: "modified" })),
      });
    throw Error("Unexpected GitHub request: " + path);
  };
}
async function complete(a: Awaited<ReturnType<typeof fixture>>, candidateId: string) {
  const inv = await getInvestigation(env.DB, a.userId, a.projectId, candidateId),
    attempt = inv.attempts![0]!;
  await env.DB.prepare(
    "UPDATE repository_check_requests SET runner_id='local-candidate' WHERE id=?",
  )
    .bind(attempt.requestId)
    .run();
  await recordInvestigationReport(env.DB, a.projectId, candidateId, {
    ...a.report,
    requestId: attempt.requestId,
    runId: "local-candidate",
    commit: "b".repeat(40),
    status: "SUCCEEDED",
    counts: { passed: 1, failed: 0, skipped: 0 },
    failures: [],
    message: "One test passed",
    exitCode: 0,
  });
}
describe("repair verification", () => {
  it("pins a candidate and preserves the original failure, with idempotent requests", async () => {
    const a = await fixture(),
      v = await createVerification(
        configured,
        a.userId,
        a.projectId,
        a.baseline.id,
        "b".repeat(40),
        "verify-request",
        github(["sum.ts"]),
      );
    expect(v.verdict).toBe("BLOCKED");
    expect(
      (await getInvestigation(env.DB, a.userId, a.projectId, v.candidateId)).snapshot.commit,
    ).toBe("b".repeat(40));
    const again = await createVerification(
      configured,
      a.userId,
      a.projectId,
      a.baseline.id,
      "b".repeat(40),
      "verify-request",
      github(["sum.ts"]),
    );
    expect(again.id).toBe(v.id);
    await complete(a, v.candidateId);
    expect((await getVerification(env.DB, a.userId, a.projectId, v.id)).verdict).toBe("PASSED");
    expect(
      (await getInvestigation(env.DB, a.userId, a.projectId, a.baseline.id)).snapshot.commit,
    ).toBe("a".repeat(40));
    const row = await env.DB.prepare(
      "SELECT report_json FROM investigation_attempts WHERE investigation_id=?",
    )
      .bind(a.baseline.id)
      .first<{ report_json: string }>();
    expect(JSON.parse(row!.report_json).status).toBe("FAILED");
  });
  it("does not label changed tests as an established behavior repair", async () => {
    const a = await fixture(),
      v = await createVerification(
        configured,
        a.userId,
        a.projectId,
        a.baseline.id,
        "b".repeat(40),
        undefined,
        github(["sum.test.ts"]),
      );
    await complete(a, v.candidateId);
    const result = await getVerification(env.DB, a.userId, a.projectId, v.id);
    expect(result.verdict).toBe("REVIEW_TEST_CHANGES");
    expect(result.metrics.agentTokens).toBeNull();
  });
  it("rejects unsupported ancestry and reused requests with a different candidate", async () => {
    const a = await fixture();
    await expect(
      createVerification(
        configured,
        a.userId,
        a.projectId,
        a.baseline.id,
        "b".repeat(40),
        undefined,
        github(["sum.ts"], "diverged"),
      ),
    ).rejects.toThrow("derived");
    await createVerification(
      configured,
      a.userId,
      a.projectId,
      a.baseline.id,
      "b".repeat(40),
      "verify-request",
      github(["sum.ts"]),
    );
    await expect(
      createVerification(
        configured,
        a.userId,
        a.projectId,
        a.baseline.id,
        "c".repeat(40),
        "verify-request",
        github(["sum.ts"]),
      ),
    ).rejects.toThrow("different verification");
  });
});
