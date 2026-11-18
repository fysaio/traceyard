import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { apiFetch, createSession, ORIGIN, readSuccess } from "./helpers";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import type { Investigation } from "../../shared/contracts/investigations";

async function account(id = 990) {
  const user = await getOrCreateGitHubIdentity(env.DB, {
    id,
    login: `investigator-${id}`,
    name: "Owner",
    avatarUrl: null,
  });
  const session = await createUserSession(env.DB, user.id, new Request(ORIGIN));
  return {
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
