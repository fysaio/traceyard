import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentResult } from "../../packages/core/src/agent-result.mjs";
import {
  buildEvidenceEnvelope,
  deriveEvidenceOutcome as deriveLocal,
  evidenceClaimSummary,
} from "../../packages/core/src/evidence.mjs";
import { singleRunEnvelope, verifyEnvelope } from "../../packages/cli/src/evidence.mjs";
import { worktreeChanged, worktreeSnapshot } from "../../packages/cli/src/git.mjs";
import { main } from "../../packages/cli/src/main.mjs";
import { guardVerdict, verifyVerdict } from "../../packages/cli/src/verdicts.mjs";
import { cliResultSchema, type CliResult } from "../../shared/contracts/cli";
import {
  deriveEvidenceOutcome,
  evidenceEnvelopeSchema,
  evidenceScopeSchema,
  evidenceStateSchema,
} from "../../shared/contracts/evidence";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Traceyard", "-c", "user.email=t@traceyard.test", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const A = "a".repeat(40);
const B = "b".repeat(40);
const FP = "f".repeat(64);
const test = { path: "sum.test.js", case: null };
const times = { startedAt: "2026-11-25T08:00:00.000Z", completedAt: "2026-11-25T08:00:01.000Z" };

type Run = {
  commit: string | null;
  status: "SUCCEEDED" | "FAILED" | "BLOCKED";
  counts: { passed: number; failed: number; skipped: number };
  failures: { file: string; name: string; message: string }[];
  truncated: boolean;
  message: string;
  durationMs: number;
  cached: boolean;
  dependencies: string;
  evidenceId: string | null;
  runner: null;
};
const run = (overrides: Partial<Run> = {}): Run => ({
  commit: A,
  status: "SUCCEEDED",
  counts: { passed: 2, failed: 0, skipped: 0 },
  failures: [],
  truncated: false,
  message: "2 passed",
  durationMs: 10,
  cached: false,
  dependencies: "none",
  evidenceId: "ev_aaaaaaaaaaaa_000000000001",
  runner: null,
  ...overrides,
});
const failed = (overrides: Partial<Run> = {}) =>
  run({
    status: "FAILED",
    counts: { passed: 1, failed: 1, skipped: 0 },
    failures: [{ file: "sum.test.js", name: "adds numbers", message: "expected -1 to be 3" }],
    ...overrides,
  });
const blocked = (overrides: Partial<Run> = {}) =>
  run({
    status: "BLOCKED",
    counts: { passed: 0, failed: 0, skipped: 0 },
    message: "Dependencies are not installed.",
    evidenceId: null,
    ...overrides,
  });

const valid = (envelope: unknown) => {
  const parsed = evidenceEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));
  return parsed.data;
};
const common = { test, repository: "github:fysaio/traceyard", requestId: "req_test", ...times };

describe("local evidence derivation matches the shared contract", () => {
  const checkSets = [
    [],
    [{ id: "a", status: "PASSED", required: false }],
    [{ id: "a", status: "FAILED", required: true }],
    [{ id: "a", status: "SKIPPED", required: true }],
    [
      { id: "a", status: "PASSED", required: true },
      { id: "b", status: "NOT_RUN", required: false },
    ],
  ] as const;

  it("derives the same outcome as the TypeScript contract for every state and scope", () => {
    for (const state of evidenceStateSchema.options)
      for (const scope of evidenceScopeSchema.options)
        for (const checks of checkSets) {
          const input = { state, scope, checks: checks.map((c) => ({ ...c })) };
          expect(deriveLocal(input), `${state}/${scope}`).toEqual(deriveEvidenceOutcome(input));
        }
  });

  it("never lets a caller turn interrupted evidence into a pass", () => {
    for (const state of ["BLOCKED", "CANCELLED", "STALE", "REJECTED"] as const) {
      const envelope = buildEvidenceEnvelope({
        evidenceId: "ev_fixture_run",
        runId: "run_1",
        requestId: "req_1",
        repositoryId: "local:abc",
        source: "LOCAL_PROVISIONAL",
        scope: "FOCUSED",
        state,
        revision: {
          commit: A,
          inputFingerprint: FP,
          policyFingerprint: FP,
          environmentFingerprint: FP,
        },
        checks: [{ id: "a", status: "PASSED", required: false }],
        limitations: ["The input changed while it ran."],
        ...times,
      });
      expect(envelope.claim).toBe("INCONCLUSIVE");
      expect(envelope.completedAt).toBeNull();
      valid(envelope);
    }
  });

  it("rejects evidence that identifies neither a commit nor a working tree", () => {
    const envelope = singleRunEnvelope({ command: "repro", run: run(), ...common });
    const parsed = evidenceEnvelopeSchema.safeParse({
      ...envelope,
      revision: { ...envelope.revision, commit: null, worktreeFingerprint: null },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("repro and check envelopes", () => {
  it("records a passing selected test as a focused, local pass only", () => {
    const envelope = valid(singleRunEnvelope({ command: "repro", run: run(), ...common }));
    expect(envelope).toMatchObject({
      source: "LOCAL_PROVISIONAL",
      scope: "FOCUSED",
      state: "COMPLETED",
      claim: "FOCUSED_PASS",
      revision: { commit: A, worktreeFingerprint: null },
    });
    expect(envelope.limitations.join(" ")).toMatch(/not a hosted attestation/);
    expect(envelope.limitations.join(" ")).toMatch(/safe to merge/);
  });

  it("maps failures, blocks and empty runs without ever claiming a pass", () => {
    expect(valid(singleRunEnvelope({ command: "repro", run: failed(), ...common }))).toMatchObject({
      state: "FAILED",
      claim: "FAILED",
    });
    const stopped = valid(singleRunEnvelope({ command: "repro", run: blocked(), ...common }));
    expect(stopped).toMatchObject({ state: "BLOCKED", claim: "INCONCLUSIVE", completedAt: null });
    expect(stopped.evidenceId).toMatch(/^ev_blocked_[a-f0-9]{12}$/);
    const empty = valid(
      singleRunEnvelope({
        command: "check",
        run: run({ commit: null, counts: { passed: 0, failed: 0, skipped: 2 } }),
        worktree: { fingerprint: FP, stale: false, complete: true },
        ...common,
      }),
    );
    expect(empty).toMatchObject({ state: "COMPLETED", claim: "INCONCLUSIVE" });
    expect(empty.limitations.join(" ")).toMatch(/no passing test/);
  });

  it("marks a check stale when the working tree changed during the run", () => {
    const envelope = valid(
      singleRunEnvelope({
        command: "check",
        run: run({ commit: null }),
        worktree: { fingerprint: FP, stale: true, complete: false },
        ...common,
      }),
    );
    expect(envelope).toMatchObject({
      state: "STALE",
      claim: "INCONCLUSIVE",
      revision: { commit: null, worktreeFingerprint: FP },
    });
    expect(envelope.limitations.join(" ")).toMatch(/changed while the test ran/);
    expect(envelope.limitations.join(" ")).toMatch(/every untracked file/);
  });

  it("says when a result was reused from the cache", () => {
    const envelope = singleRunEnvelope({ command: "repro", run: run({ cached: true }), ...common });
    expect(envelope.limitations.join(" ")).toMatch(/reused from an earlier run/);
  });
});

describe("verify envelopes agree with the verify verdict", () => {
  const cases: [string, Run, Run | null, string[]][] = [
    ["fixed", failed(), run({ commit: B }), []],
    ["test edited", failed(), run({ commit: B }), ["sum.test.js"]],
    ["not reproduced", run(), null, []],
    ["more skips", failed(), run({ commit: B, counts: { passed: 1, failed: 0, skipped: 1 } }), []],
    [
      "no passing test",
      failed(),
      run({ commit: B, counts: { passed: 0, failed: 0, skipped: 0 } }),
      [],
    ],
    ["same commit", failed(), failed(), []],
    ["still failing", failed(), failed({ commit: B }), []],
    ["baseline blocked", blocked({ commit: A }), null, []],
    ["candidate blocked", failed(), blocked({ commit: B }), []],
  ];

  it.each(cases)("%s", (_name, baseline, candidate, changedTests) => {
    const verdict = verifyVerdict({
      baseline,
      candidate: candidate ?? baseline,
      testPath: test.path,
      changedFiles: changedTests,
    });
    const envelope = valid(verifyEnvelope({ baseline, candidate, changedTests, ...common }));
    // FIXED is the only verdict that can carry a pass.
    expect(envelope.claim === "FOCUSED_PASS").toBe(verdict.verdict === "FIXED");
    if (verdict.verdict === "BLOCKED") expect(envelope.state).toBe("BLOCKED");
    if (verdict.verdict === "STILL_FAILING") expect(envelope.claim).toBe("FAILED");
    if (["NEEDS_REVIEW", "INCONCLUSIVE", "NOT_REPRODUCED"].includes(verdict.verdict))
      expect(envelope.claim).toBe("INCONCLUSIVE");
    expect(envelope.revision.commit).toBe((candidate ?? baseline).commit);
  });
});

describe("guard and receipts", () => {
  const receipt = {
    id: "rcpt_20261125080000000_abcdef",
    verdict: "FIXED",
    summary: "fixed",
    test,
    baseline: { commit: A },
    candidate: { commit: B },
  };
  const evidence = verifyEnvelope({
    baseline: failed(),
    candidate: run({ commit: B }),
    changedTests: [],
    ...common,
  });

  it("accepts a FIXED receipt whose envelope agrees, and older receipts without one", () => {
    expect(
      guardVerdict({ receipt: { ...receipt, evidenceEnvelope: evidence }, intact: true, head: B })
        .verdict,
    ).toBe("FIXED");
    expect(guardVerdict({ receipt, intact: true, head: B }).verdict).toBe("FIXED");
  });

  it("refuses a FIXED receipt whose envelope disagrees", () => {
    for (const evidenceEnvelope of [
      { ...evidence, claim: "INCONCLUSIVE" },
      { ...evidence, state: "STALE" },
      { ...evidence, revision: { ...evidence.revision, commit: A } },
    ])
      expect(
        guardVerdict({ receipt: { ...receipt, evidenceEnvelope }, intact: true, head: B }).verdict,
      ).toBe("NEEDS_REVIEW");
  });
});

describe("compact agent responses keep the claim", () => {
  it("never drops state, claim, scope, source or commit, even at the smallest budget", () => {
    const envelope = verifyEnvelope({
      baseline: failed({ truncated: true, cached: true }),
      candidate: run({ commit: B, cached: true }),
      changedTests: ["sum.test.js"],
      ...common,
    });
    const claim = evidenceClaimSummary(envelope);
    const { structuredContent } = agentResult(
      {
        status: "NEEDS_REVIEW",
        summary: "x".repeat(3000),
        next: "Review the changed test files.",
        test,
        runs: [{ role: "candidate", commit: B, evidenceId: envelope.evidenceId, failures: [] }],
        claim,
      },
      1000,
    );
    const compact = structuredContent.claim as { limitations: string[] };
    expect(compact).toMatchObject({
      state: "COMPLETED",
      claim: "INCONCLUSIVE",
      scope: "FOCUSED",
      source: "LOCAL_PROVISIONAL",
      commit: B,
    });
    expect(compact.limitations.length).toBeGreaterThanOrEqual(1);
    expect(structuredContent.omitted).toBe(true);
  });
});

describe("working-tree snapshots", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "traceyard-worktree-"));
    await writeFile(join(repo, "a.js"), "1");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    await writeFile(join(repo, "draft.js"), "draft");
  });
  afterAll(() => rm(repo, { recursive: true, force: true }));

  it("is stable for the same tree and changes with any edit", async () => {
    const first = await worktreeSnapshot(repo);
    const again = await worktreeSnapshot(repo);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(first.complete).toBe(true);

    await writeFile(join(repo, "a.js"), "2");
    const tracked = await worktreeSnapshot(repo);
    expect(tracked.fingerprint).not.toBe(first.fingerprint);
    expect(worktreeChanged(first, tracked)).toBe(true);
    await writeFile(join(repo, "a.js"), "1");

    await writeFile(join(repo, "draft.js"), "edited");
    const untracked = await worktreeSnapshot(repo);
    expect(worktreeChanged(first, untracked)).toBe(true);
    await writeFile(join(repo, "draft.js"), "draft");

    // A cache file a test runner creates doesn't make the run stale.
    await writeFile(join(repo, "cache.pyc"), "bytes");
    const cache = await worktreeSnapshot(repo);
    expect(cache.fingerprint).not.toBe(first.fingerprint);
    expect(worktreeChanged(first, cache)).toBe(false);
  });
});

describe("traceyard check on a tree that changes mid-run", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "traceyard-stale-"));
    const api = pathToFileURL(resolve("node_modules/vitest/dist/index.js")).href;
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({
        type: "module",
        scripts: { test: `node ${JSON.stringify(resolve("node_modules/vitest/vitest.mjs"))} run` },
      }),
    );
    // A passing test that rewrites a tracked file while it runs.
    await writeFile(
      join(repo, "sum.test.js"),
      `import {it,expect} from ${JSON.stringify(api)};import {writeFileSync} from 'node:fs';it('adds',()=>{writeFileSync(new URL('./notes.txt', import.meta.url),'changed');expect(1+2).toBe(3);});`,
    );
    await writeFile(join(repo, "notes.txt"), "original");
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
  });
  afterAll(() => rm(repo, { recursive: true, force: true }));

  const cli = async (args: string[]) => {
    const out: string[] = [];
    await main(
      [...args, "--json", "--repo", repo],
      { stdout: (l) => out.push(l), stderr: () => {} },
      { env: { ...process.env, VITEST: "" } },
    );
    return cliResultSchema.parse(JSON.parse(out[0]!)) as CliResult;
  };

  it("reports a stale, inconclusive result instead of a pass", async () => {
    const result = await cli(["check", "sum.test.js"]);
    expect(result.runs[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(result).toMatchObject({ verdict: "INCONCLUSIVE", exitCode: 2 });
    expect(result.evidenceEnvelope).toMatchObject({ state: "STALE", claim: "INCONCLUSIVE" });
    expect(await readFile(join(repo, "notes.txt"), "utf8")).toBe("changed");
  }, 60_000);

  it("passes once the tree stays the same during the run", async () => {
    // notes.txt now already says "changed", so the rewrite is a no-op.
    const result = await cli(["check", "sum.test.js"]);
    expect(result).toMatchObject({ verdict: "PASSED", exitCode: 0 });
    expect(result.evidenceEnvelope).toMatchObject({
      state: "COMPLETED",
      claim: "FOCUSED_PASS",
      revision: { commit: null },
    });
    expect(result.evidenceEnvelope!.revision.worktreeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  }, 60_000);
});
