import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:workers";
import { apiFetch, createSession, ORIGIN, readSuccess } from "./helpers";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import {
  beginInvestigation,
  recordInvestigationReport,
} from "../../worker/services/investigation-execution";
import { getInvestigation } from "../../worker/services/investigation-service";
import {
  investigationRequestSchema,
  type Investigation,
} from "../../shared/contracts/investigations";
import type { InvestigationReport } from "../../shared/contracts/investigation-execution";
import { DEFAULT_RUNNER_REF, runnerWorkflow } from "../../worker/repositories/runner-workflow";

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
    PUBLIC_APP_ORIGIN: "https://traceyard.example",
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

async function account(id = 990) {
  const user = await getOrCreateGitHubIdentity(env.DB, {
    id,
    login: `investigator-${id}`,
    name: "Owner",
    avatarUrl: null,
  });
  const session = await createUserSession(env.DB, user.id, new Request(ORIGIN));
  return {
    userId: user.id,
    cookie: (await createSession()).cookie + "; ty_auth_session=" + session.token,
    projectId: (await getDefaultProjectId(env.DB, user.id))!,
  };
}
function call(a: { cookie: string }, path: string, body?: unknown) {
  return apiFetch(path, {
    method: body ? "POST" : "GET",
    headers: { cookie: a.cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function source(a: { projectId: string }) {
  await env.DB.prepare(
    "INSERT INTO project_repositories(project_id,full_name,status,commit_sha,scan_json,updated_at) VALUES(?,'Example/app','DISCOVERED',?,?,?)",
  )
    .bind(
      a.projectId,
      "a".repeat(40),
      JSON.stringify({
        filesScanned: 1,
        warnings: ["Partial source coverage"],
        operations: [{ name: "GET /health", file: "api.ts", line: 5, calls: ["load"] }],
      }),
      new Date().toISOString(),
    )
    .run();
}
describe("shared investigations", () => {
  it("refuses the wrong connected repository before creating an investigation", async () => {
    const a = await account();
    await source(a);
    const response = await call(a, `/api/projects/${a.projectId}/investigations`, {
      question: "Inspect my local repository",
      expectedRepository: "example/other",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "REPOSITORY_MISMATCH",
    );
    const list = await readSuccess<{ items: Investigation[] }>(
      await call(a, `/api/projects/${a.projectId}/investigations`),
    );
    expect(list.items).toHaveLength(0);
    const accepted = await call(a, `/api/projects/${a.projectId}/investigations`, {
      question: "Inspect my local repository",
      expectedRepository: "example/app",
    });
    expect(accepted.status).toBe(201);
  });
  it("pins a source snapshot and exposes bounded evidence without application keys", async () => {
    const a = await account();
    await source(a);
    const inv = await readSuccess<Investigation>(
      await call(a, `/api/projects/${a.projectId}/investigations`, {
        question: "Understand the health operation",
        outputChars: 500,
      }),
    );
    expect(inv.status).toBe("EVIDENCE_READY");
    expect(inv.snapshot.commit).toBe("a".repeat(40));
    expect(inv.finding.basis).toBe("source");
    expect(inv.finding.limitations).toContain("Partial source coverage");
    const evidence = await readSuccess<{ text: string; nextOffset: number | null }>(
      await call(
        a,
        `/api/projects/${a.projectId}/investigations/${inv.id}/evidence/${inv.evidence[0]!.id}?limit=100`,
      ),
    );
    expect(evidence.text.length).toBeLessThanOrEqual(100);
    expect(evidence.nextOffset).not.toBeNull();
    await env.DB.prepare("UPDATE project_repositories SET commit_sha=? WHERE project_id=?")
      .bind("b".repeat(40), a.projectId)
      .run();
    const retained = await readSuccess<Investigation>(
      await call(a, `/api/projects/${a.projectId}/investigations/${inv.id}`),
    );
    expect(retained.snapshot.commit).toBe("a".repeat(40));
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys").first<{ n: number }>())?.n,
    ).toBe(0);
  });
  it("deduplicates concurrent requests and rejects a reused key with different intent", async () => {
    const a = await account();
    await source(a);
    const path = `/api/projects/${a.projectId}/investigations`,
      body = { question: "Investigate health", requestKey: "request-00001" };
    const results = await Promise.all([call(a, path, body), call(a, path, body)]);
    const invs = await Promise.all(results.map((r) => readSuccess<Investigation>(r)));
    expect(invs[0]!.id).toBe(invs[1]!.id);
    expect((await call(a, path, { ...body, question: "Different problem" })).status).toBe(409);
    const list = await readSuccess<{ items: Investigation[] }>(await call(a, path));
    expect(list.items).toHaveLength(1);
  });
  it("isolates investigations and evidence and does not disclose foreign checks", async () => {
    const a = await account(),
      other = await account(991);
    const inv = await readSuccess<Investigation>(
      await call(a, `/api/projects/${a.projectId}/investigations`, {
        question: "Inspect available source",
      }),
    );
    const path = `/api/projects/${a.projectId}/investigations/${inv.id}`;
    expect((await call(other, path)).status).toBe(404);
    expect((await call(other, path + `/evidence/${inv.evidence[0]!.id}`)).status).toBe(404);
    expect(
      (
        await call(other, `/api/projects/${other.projectId}/investigations`, {
          question: "Inspect a private check",
          target: { kind: "check", ref: "private-check" },
        })
      ).status,
    ).toBe(404);
    expect((await apiFetch(`/api/projects/${a.projectId}/investigations`)).status).toBe(401);
  });
  it("retains observed failure evidence and the failed check's revision", async () => {
    const a = await account();
    await source(a);
    await env.DB.prepare(
      "INSERT INTO repository_jobs(id,project_id,commit_sha,source,phase,status,events_json,updated_at) VALUES('check-1',?,?,'local','test','FAILED',?,?)",
    )
      .bind(
        a.projectId,
        "c".repeat(40),
        JSON.stringify([{ message: "Assertion failed; Bearer abcdefghijklmnopqrstuvwxyz" }]),
        new Date().toISOString(),
      )
      .run();
    const inv = await readSuccess<Investigation>(
      await call(a, `/api/projects/${a.projectId}/investigations`, {
        question: "Why did the check fail?",
        target: { kind: "check", ref: "check-1" },
      }),
    );
    expect(inv.snapshot.commit).toBe("c".repeat(40));
    expect(inv.finding.basis).toBe("observed");
    expect(inv.finding.summary).toContain("FAILED");
    expect(JSON.stringify(inv)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    const ev = await readSuccess<{ text: string }>(
      await call(
        a,
        `/api/projects/${a.projectId}/investigations/${inv.id}/evidence/${inv.evidence[0]!.id}`,
      ),
    );
    expect(ev.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
  it("validates evidence ranges and target shapes", async () => {
    const a = await account();
    expect(
      (
        await call(a, `/api/projects/${a.projectId}/investigations`, {
          question: "Inspect",
          outputChars: 1000000,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(a, `/api/projects/${a.projectId}/investigations`, {
          question: "Inspect",
          target: { kind: "shell", command: "anything" },
        })
      ).status,
    ).toBe(400);
  });
});

async function connectedSource(
  a: { projectId: string; userId?: string },
  defaultCommit = "a".repeat(40),
) {
  const at = new Date().toISOString();
  const identity = a.userId
    ? await env.DB.prepare(
        "SELECT provider_subject,provider_login FROM identities WHERE user_id=? AND provider='github'",
      )
        .bind(a.userId)
        .first<{ provider_subject: string; provider_login: string }>()
    : null;
  const accountId = identity?.provider_subject ?? "990";
  const login = identity?.provider_login ?? "investigator-990";
  const installId = Number(accountId) || 99;
  await env.DB.prepare(
    "INSERT INTO github_installations(id,account_id,account_login,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,account_login=excluded.account_login,updated_at=excluded.updated_at",
  )
    .bind(installId, accountId, login, at)
    .run();
  await env.DB.prepare(
    "INSERT INTO project_repositories(project_id,repository_id,installation_id,full_name,default_branch,status,commit_sha,scan_json,updated_at) VALUES(?,99,?, 'Example/app','main','DISCOVERED',?,?,?)",
  )
    .bind(
      a.projectId,
      installId,
      defaultCommit,
      JSON.stringify({
        filesScanned: 1,
        warnings: ["Partial source coverage"],
        operations: [{ name: "GET /health", file: "api.ts", line: 5, calls: ["load"] }],
      }),
      at,
    )
    .run();
}

function mockGitHub(commitSha?: string, status = 200): typeof fetch {
  return async (input) => {
    const url = String(input);
    const path = new URL(url).pathname;
    if (path.endsWith("/access_tokens")) {
      return Response.json({ token: "fixture-token" });
    }
    if (path.includes("/commits/")) {
      if (status === 200) {
        return Response.json({ sha: commitSha ?? "c".repeat(40) });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status });
    }
    throw Error("Unexpected GitHub request: " + url);
  };
}

describe("explicit commit selection", () => {
  it("executes an explicit commit with an isolated snapshot without stale source evidence", async () => {
    const a = await account(992);
    await connectedSource(a);
    const commitSha = "c".repeat(40);
    const inv = await beginInvestigation(
      configured,
      a.userId,
      a.projectId,
      investigationRequestSchema.parse({
        mode: "execute",
        question: "Execute test at specific commit",
        commit: commitSha,
        testPath: "tests/unit/api-client.test.ts",
      }),
      mockGitHub(commitSha),
    );
    expect(inv.snapshot.commit).toBe(commitSha);
    expect(inv.snapshot.repository).toBe("Example/app");
    expect(inv.evidence).toHaveLength(0);

    const attempts = await env.DB.prepare(
      "SELECT plan_json FROM investigation_attempts WHERE investigation_id=?",
    )
      .bind(inv.id)
      .all<{ plan_json: string }>();
    expect(attempts.results).toHaveLength(1);
    const plan = JSON.parse(attempts.results[0]!.plan_json);
    expect(plan.commit).toBe(commitSha);
    expect(plan.testPath).toBe("tests/unit/api-client.test.ts");
  });

  it("dispatches workflow to default branch with explicit commit in runner manifest", async () => {
    const a = await account(999);
    await connectedSource(a);
    await env.DB.prepare(
      "UPDATE project_repositories SET runner_enabled=1,check_setup_state='READY' WHERE project_id=?",
    )
      .bind(a.projectId)
      .run();

    const commitSha = "d".repeat(40);
    const dispatches: { path: string; body: { ref: string; inputs: { run_request: string } } }[] =
      [];
    const workflow = runnerWorkflow(configured.PUBLIC_APP_ORIGIN!, DEFAULT_RUNNER_REF);

    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (path.endsWith("/access_tokens")) {
        return Response.json({ token: "fixture-token" });
      }
      if (path.includes("/commits/")) {
        return Response.json({ sha: commitSha });
      }
      if (path.endsWith("/contents/.github/workflows/traceyard.yml")) {
        return Response.json({
          content: btoa(workflow),
          sha: "w".repeat(40),
        });
      }
      if (path.endsWith("/dispatches")) {
        dispatches.push({ path, body });
        return new Response(null, { status: 204 });
      }
      throw Error("Unexpected GitHub request: " + url);
    };

    const inv = await beginInvestigation(
      configured,
      a.userId,
      a.projectId,
      investigationRequestSchema.parse({
        mode: "execute",
        question: "Execute test at explicit commit",
        commit: commitSha,
        testPath: "tests/unit/api-client.test.ts",
      }),
      fetcher,
    );

    expect(inv.status).toBe("EXECUTING");
    expect(inv.snapshot.commit).toBe(commitSha);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.body.ref).toBe("main");
    const runRequestId = dispatches[0]!.body.inputs.run_request;
    expect(typeof runRequestId).toBe("string");

    const savedReq = await env.DB.prepare(
      "SELECT snapshot_json FROM repository_check_requests WHERE id=?",
    )
      .bind(runRequestId)
      .first<{ snapshot_json: string }>();
    expect(savedReq).not.toBeNull();
    const snapshotObj = JSON.parse(savedReq!.snapshot_json);
    expect(snapshotObj.investigation.commit).toBe(commitSha);
    expect(snapshotObj.investigation.testPath).toBe("tests/unit/api-client.test.ts");

    const attempt = await env.DB.prepare(
      "SELECT status,check_id,request_id FROM investigation_attempts WHERE investigation_id=?",
    )
      .bind(inv.id)
      .first<{ status: string; check_id: string; request_id: string }>();
    expect(attempt).not.toBeNull();
    expect(attempt!.status).toBe("QUEUED");
    expect(attempt!.check_id).toMatch(/^ci_/);
    expect(attempt!.request_id).toBe(runRequestId);

    const checkDispatch = await env.DB.prepare(
      "SELECT state,snapshot_request_id FROM github_check_dispatches WHERE id=?",
    )
      .bind(attempt!.check_id)
      .first<{ state: string; snapshot_request_id: string }>();
    expect(checkDispatch).not.toBeNull();
    expect(checkDispatch!.state).toBe("QUEUED");
    expect(checkDispatch!.snapshot_request_id).toBe(runRequestId);
  });

  it("rejects inaccessible or missing commits", async () => {
    const a = await account(993);
    await connectedSource(a);
    const commitSha = "c".repeat(40);
    await expect(
      beginInvestigation(
        configured,
        a.userId,
        a.projectId,
        investigationRequestSchema.parse({
          mode: "execute",
          question: "Execute missing commit",
          commit: commitSha,
          testPath: "tests/unit/api-client.test.ts",
        }),
        mockGitHub(commitSha, 404),
      ),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      beginInvestigation(
        configured,
        a.userId,
        a.projectId,
        investigationRequestSchema.parse({
          mode: "execute",
          question: "Execute inaccessible commit",
          commit: commitSha,
          testPath: "tests/unit/api-client.test.ts",
        }),
        mockGitHub(commitSha, 403),
      ),
    ).rejects.toMatchObject({ status: 400, code: "COMMIT_INACCESSIBLE" });
  });

  it("rejects incompatible requests when commit is provided", async () => {
    const a = await account(994);
    await connectedSource(a);
    const commitSha = "c".repeat(40);

    await expect(
      beginInvestigation(
        configured,
        a.userId,
        a.projectId,
        investigationRequestSchema.parse({
          mode: "replay",
          question: "Replay incompatible",
          commit: commitSha,
        }),
        mockGitHub(commitSha),
      ),
    ).rejects.toMatchObject({ status: 400, code: "COMMIT_SELECTION_UNSUPPORTED" });

    await expect(
      beginInvestigation(
        configured,
        a.userId,
        a.projectId,
        investigationRequestSchema.parse({
          mode: "analyze",
          question: "Analyze with commit",
          commit: commitSha,
        }),
        mockGitHub(commitSha),
      ),
    ).rejects.toMatchObject({ status: 400, code: "COMMIT_SELECTION_UNSUPPORTED" });

    await expect(
      beginInvestigation(
        configured,
        a.userId,
        a.projectId,
        investigationRequestSchema.parse({
          mode: "execute",
          question: "Check target with commit",
          commit: commitSha,
          target: { kind: "check", ref: "check-123" },
        }),
        mockGitHub(commitSha),
      ),
    ).rejects.toMatchObject({ status: 400, code: "COMMIT_SELECTION_UNSUPPORTED" });

    expect(() =>
      investigationRequestSchema.parse({
        question: "Invalid commit format",
        commit: "short-sha",
      }),
    ).toThrow();
  });

  it("preserves default behavior and indexed source when no commit is specified", async () => {
    const a = await account(995);
    await connectedSource(a, "a".repeat(40));
    const inv = await beginInvestigation(
      configured,
      a.userId,
      a.projectId,
      investigationRequestSchema.parse({
        mode: "analyze",
        question: "Analyze default branch",
      }),
    );
    expect(inv.snapshot.commit).toBe("a".repeat(40));
    expect(inv.evidence.length).toBeGreaterThan(0);
    expect(inv.evidence[0]!.title).toContain("Indexed source operations");
  });

  it("retains immutable snapshot identity on repeated requests", async () => {
    const a = await account(996);
    await connectedSource(a);
    const commitSha = "c".repeat(40);
    const req = investigationRequestSchema.parse({
      mode: "execute",
      question: "Deduplicated request",
      commit: commitSha,
      requestKey: "test-req-001",
      testPath: "tests/unit/api-client.test.ts",
    });

    const first = await beginInvestigation(
      configured,
      a.userId,
      a.projectId,
      req,
      mockGitHub(commitSha),
    );
    await env.DB.prepare("UPDATE project_repositories SET commit_sha=? WHERE project_id=?")
      .bind("d".repeat(40), a.projectId)
      .run();

    const second = await beginInvestigation(
      configured,
      a.userId,
      a.projectId,
      req,
      mockGitHub(commitSha),
    );
    expect(second.id).toBe(first.id);
    expect(second.snapshot.commit).toBe(commitSha);

    const reloaded = await getInvestigation(env.DB, a.userId, a.projectId, first.id);
    expect(reloaded.snapshot.commit).toBe(commitSha);
  });

  it("rejects execution report with commit mismatch", async () => {
    const a = await account(997);
    await connectedSource(a);
    const commitSha = "c".repeat(40);
    const inv = await beginInvestigation(
      configured,
      a.userId,
      a.projectId,
      investigationRequestSchema.parse({
        mode: "execute",
        question: "Report mismatch test",
        commit: commitSha,
        testPath: "tests/unit/api-client.test.ts",
      }),
      mockGitHub(commitSha),
    );

    const attempt = (await getInvestigation(env.DB, a.userId, a.projectId, inv.id)).attempts![0]!;
    await env.DB.prepare(
      "UPDATE repository_check_requests SET runner_id='authorized-runner' WHERE id=?",
    )
      .bind(attempt.requestId)
      .run();

    const mismatchedReport: InvestigationReport = {
      requestId: attempt.requestId,
      runId: "authorized-runner",
      commit: "d".repeat(40),
      status: "SUCCEEDED",
      command: { directory: ".", script: "test", testPath: "tests/unit/api-client.test.ts" },
      counts: { passed: 1, failed: 0, skipped: 0 },
      failures: [],
      message: "One test passed",
      durationMs: 150,
      exitCode: 0,
      truncated: false,
      nodeVersion: "v22",
    };

    await expect(
      recordInvestigationReport(env.DB, a.projectId, inv.id, mismatchedReport),
    ).rejects.toMatchObject({
      status: 409,
      code: "INVESTIGATION_REVISION_MISMATCH",
    });
  });

  it("binds Pytest evidence to the authorized case and its exact result count", async () => {
    const a = await account(1007);
    await connectedSource(a);
    const commitSha = "c".repeat(40);
    const inv = await beginInvestigation(
      configured,
      a.userId,
      a.projectId,
      investigationRequestSchema.parse({
        mode: "execute",
        question: "Reproduce the wallet checkout",
        commit: commitSha,
        testPath: "tests/test_checkout.py",
        testCase: "TestCheckout::test_total[wallet]",
      }),
      mockGitHub(commitSha),
    );

    const attempt = (await getInvestigation(env.DB, a.userId, a.projectId, inv.id)).attempts![0]!;
    await env.DB.prepare(
      "UPDATE repository_check_requests SET runner_id='authorized-runner' WHERE id=?",
    )
      .bind(attempt.requestId)
      .run();

    const mismatchedReport: InvestigationReport = {
      requestId: attempt.requestId,
      runId: "authorized-runner",
      commit: commitSha,
      status: "SUCCEEDED",
      command: {
        directory: ".",
        script: "pytest",
        testPath: "tests/test_checkout.py",
        testCase: "TestCheckout::test_total[card]",
      },
      counts: { passed: 1, failed: 0, skipped: 0 },
      failures: [],
      message: "One test passed",
      durationMs: 150,
      exitCode: 0,
      truncated: false,
      nodeVersion: "v22",
    };

    await expect(
      recordInvestigationReport(env.DB, a.projectId, inv.id, mismatchedReport),
    ).rejects.toMatchObject({
      status: 409,
      code: "INVESTIGATION_TEST_MISMATCH",
    });
    const correct = {
      ...mismatchedReport,
      command: { ...mismatchedReport.command, testCase: "TestCheckout::test_total[wallet]" },
    };
    await expect(
      recordInvestigationReport(env.DB, a.projectId, inv.id, {
        ...correct,
        counts: { passed: 2, failed: 0, skipped: 0 },
      }),
    ).rejects.toMatchObject({ code: "INVESTIGATION_TEST_MISMATCH" });
    await recordInvestigationReport(env.DB, a.projectId, inv.id, correct);
    const stored = await getInvestigation(env.DB, a.userId, a.projectId, inv.id);
    expect(stored.execution?.command.testCase).toBe("TestCheckout::test_total[wallet]");
  });

  it("preserves replay compatibility without commit selection", async () => {
    const a = await account(998);
    await connectedSource(a);
    const prev = await beginInvestigation(
      configured,
      a.userId,
      a.projectId,
      investigationRequestSchema.parse({
        mode: "execute",
        question: "Previous run for recording",
        testPath: "tests/unit/api-client.test.ts",
      }),
    );
    const attempt = (await getInvestigation(env.DB, a.userId, a.projectId, prev.id)).attempts![0]!;
    const manifest = JSON.stringify({
      schemaVersion: 1,
      kind: "json-fetch",
      sourceCommit: "a".repeat(40),
      testPath: "tests/unit/api-client.test.ts",
      interactions: [],
      environment: [],
      omissions: [],
      eligible: false,
    });
    await env.DB.prepare(
      "INSERT INTO investigation_recordings(id,investigation_id,project_id,request_id,manifest_json,eligible,created_at) VALUES(?,?,?,?,?,0,?)",
    )
      .bind(
        "rcd_" + "f".repeat(32),
        prev.id,
        a.projectId,
        attempt.requestId,
        manifest,
        new Date().toISOString(),
      )
      .run();

    await expect(
      beginInvestigation(
        configured,
        a.userId,
        a.projectId,
        investigationRequestSchema.parse({
          mode: "replay",
          question: "Replay without commit",
          recordingId: "rcd_" + "f".repeat(32),
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "REPLAY_UNAVAILABLE" });
  });

  it("executes an eligible replay without commit selection", async () => {
    const a = await account(1001);
    await connectedSource(a);
    const prev = await beginInvestigation(
      configured,
      a.userId,
      a.projectId,
      investigationRequestSchema.parse({
        mode: "execute",
        question: "Previous run for recording",
        testPath: "tests/unit/api-client.test.ts",
      }),
    );
    const attempt = (await getInvestigation(env.DB, a.userId, a.projectId, prev.id)).attempts![0]!;
    const manifest = JSON.stringify({
      schemaVersion: 1,
      kind: "json-fetch",
      sourceCommit: "a".repeat(40),
      testPath: "tests/unit/api-client.test.ts",
      interactions: [],
      environment: [],
      omissions: [],
      eligible: true,
    });
    await env.DB.prepare(
      "INSERT INTO investigation_recordings(id,investigation_id,project_id,request_id,manifest_json,eligible,created_at) VALUES(?,?,?,?,?,1,?)",
    )
      .bind(
        "rcd_" + "e".repeat(32),
        prev.id,
        a.projectId,
        attempt.requestId,
        manifest,
        new Date().toISOString(),
      )
      .run();

    const replayInv = await beginInvestigation(
      configured,
      a.userId,
      a.projectId,
      investigationRequestSchema.parse({
        mode: "replay",
        question: "Replay eligible recording",
        recordingId: "rcd_" + "e".repeat(32),
      }),
    );
    expect(replayInv.snapshot.commit).toBe("a".repeat(40));
    expect(replayInv.snapshot.repository).toBe("Example/app");
    const attemptRow = await env.DB.prepare(
      "SELECT plan_json FROM investigation_attempts WHERE investigation_id=?",
    )
      .bind(replayInv.id)
      .first<{ plan_json: string }>();
    expect(attemptRow).not.toBeNull();
    const plan = JSON.parse(attemptRow!.plan_json);
    expect(plan.replayRecording?.id).toBe("rcd_" + "e".repeat(32));
    expect(plan.commit).toBe("a".repeat(40));
  });
});
