import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ProjectLink as Link } from "../components/project-link";
import {
  Badge,
  Empty,
  ErrorMessage,
  GitHubMark,
  Icon,
  PageHeader,
  Spinner,
  formatTime,
  shortSha,
  type Tone,
} from "../components/ui";
import { ExecutionSummary } from "../components/execution-summary";
import { useWorkspace } from "../lib/workspace";
import { investigations } from "../lib/investigations-api";
import { integrationRequest } from "../lib/integrations-api";
import { newIdempotencyKey } from "../lib/api";
import { EnableGitHubChecks, repositoryPath, type CISetupResult } from "./repositories";
import {
  investigationRepositorySchema,
  type Investigation,
} from "../../shared/contracts/investigations";
import { pytestCaseSchema } from "../../shared/contracts/investigation-execution";
import { repositoryPathSchema } from "../../shared/contracts/repository-index";
import type { Catalog } from "../../shared/repository/workspace";

const STATE: Record<string, [label: string, tone: Tone]> = {
  EVIDENCE_READY: ["Done", "neutral"],
  OVERVIEW: ["Overview", "neutral"],
  BLOCKED_ATTEMPT: ["Blocked", "warn"],
  QUEUED: ["Queued", "running"],
  RUNNING: ["Running", "running"],
  EXECUTING: ["Running", "running"],
  ANALYZING: ["Reading code", "running"],
  PENDING: ["Running", "running"],
  PASSED: ["Fixed", "pass"],
  REVIEW_TEST_CHANGES: ["Passed, tests changed", "warn"],
  INCONCLUSIVE: ["Inconclusive", "warn"],
  BLOCKED: ["Needs attention", "warn"],
  CANCELLED: ["Cancelled", "neutral"],
  SUCCEEDED: ["Passed", "pass"],
  FAILED: ["Failed", "fail"],
};

function State({ value }: { value: string }) {
  const [label, tone] = STATE[value] ?? [value.toLowerCase().replaceAll("_", " "), "neutral"];
  return <Badge tone={tone}>{label}</Badge>;
}

const isOverview = (i: Investigation) =>
  i.finding.basis === "source" &&
  i.target.kind === "source" &&
  !i.execution &&
  !i.outcome &&
  !i.attempts?.length;
const kindLabel = (i: Investigation) => (isOverview(i) ? "Code overview" : "Test run");
/** One status per row: the test result once there is one, otherwise the investigation state. */
const listStatus = (i: Investigation) =>
  i.status === "EVIDENCE_READY"
    ? (i.outcome ?? i.execution?.status ?? (isOverview(i) ? "OVERVIEW" : i.status))
    : i.status;

const busy = (i: Investigation | undefined) =>
  i?.status === "EXECUTING" || i?.status === "ANALYZING";

const SHA = "[a-f0-9]{40}";

function TestFileField({
  projectId,
  value,
  onChange,
  required = false,
}: {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const index = useQuery({
    queryKey: ["indexed-tests", projectId],
    queryFn: () =>
      integrationRequest<{ files: { path: string }[]; truncated: boolean } | null>(
        projectId,
        "repository/index?kind=tests",
      ),
  });
  return (
    <label className="field">
      <span className="field-label">{required ? "Test file" : "Test file (optional)"}</span>
      <input
        className="mono"
        required={required}
        list="indexed-tests"
        value={value}
        maxLength={240}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        placeholder="src/checkout.test.ts"
      />
      <datalist id="indexed-tests">
        {index.data?.files.map((f) => (
          <option key={f.path} value={f.path} />
        ))}
      </datalist>
      <span className="field-hint">
        {index.data?.truncated
          ? "Suggestions show the first 100 tests. Any path in the repository works."
          : "Path from the top of the repository. Vitest, Jest and Pytest work."}
      </span>
      <ErrorMessage error={index.error} />
    </label>
  );
}

function PytestCaseField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">Test name (optional)</span>
      <input
        className="mono"
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        maxLength={240}
        placeholder="TestCheckout::test_total[wallet]"
      />
      <span className="field-hint">
        For example TestCheckout::test_total. Leave blank to run the whole file.
      </span>
    </label>
  );
}

export function InvestigationsPage() {
  const { projectId, projects, openConnect } = useWorkspace(),
    navigate = useNavigate(),
    cache = useQueryClient();
  const project = projects.find((p) => p.id === projectId);
  const [params] = useSearchParams();
  const ciRepository = investigationRepositorySchema.safeParse(params.get("ciRepository")).data;
  const ciTest = repositoryPathSchema.safeParse(params.get("ciTest")).data;
  const ciCase = pytestCaseSchema.safeParse(params.get("ciCase")).data;
  const ciCommit = params.get("ciCommit");
  const handoff =
    ciRepository &&
    ciTest?.endsWith(".py") &&
    ciCase &&
    ciCommit &&
    /^[a-f0-9]{40}$/.test(ciCommit);
  const ciProject = handoff
    ? projects.find((p) => p.repository?.toLowerCase() === ciRepository.toLowerCase())
    : undefined;
  const prefill = ciProject?.id === projectId && !!projectId;
  const picked = repositoryPathSchema.safeParse(params.get("test")).data;
  const [testPath, setTestPath] = useState(prefill ? (ciTest ?? "") : (picked ?? "")),
    [testCase, setTestCase] = useState(prefill ? (ciCase ?? "") : ""),
    [commit, setCommit] = useState(prefill ? (ciCommit ?? "") : ""),
    [ciUrl, setCiUrl] = useState(""),
    [useCiLink, setUseCiLink] = useState(false),
    [setup, setSetup] = useState(false),
    [key, setKey] = useState(newIdempotencyKey);
  const fresh = () => setKey(newIdempotencyKey());
  const python = testPath.endsWith(".py");
  const catalog = useQuery({
    queryKey: ["catalog", projectId],
    queryFn: () => integrationRequest<Catalog>(projectId, "catalog"),
    enabled: !!project?.repository,
  });
  const usesGitHub = catalog.data?.executionProvider === "github";
  const githubSetup = useQuery({
    queryKey: ["ci-setup", projectId],
    queryFn: () => integrationRequest<CISetupResult>(projectId, "repository/setup"),
    enabled: !!project?.repository && usesGitHub,
    retry: false,
  });
  const checkingSetup = catalog.isPending || (usesGitHub && githubSetup.isPending);
  const ready =
    catalog.data?.executionAvailable && (!usesGitHub || githubSetup.data?.state === "READY");
  const q = useQuery({
    queryKey: ["investigations", projectId],
    queryFn: () => investigations.list(projectId),
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.items.some(busy) ? 5000 : false),
  });
  const create = useMutation({
    mutationFn: () =>
      investigations.create(projectId, {
        question: `Reproduce ${testPath}`,
        mode: "execute",
        testPath: testPath || undefined,
        testCase: python ? testCase.trim() || undefined : undefined,
        expectedRepository: project?.repository ?? undefined,
        commit: commit || undefined,
        requestKey: key,
      }),
    onSuccess: (inv) => {
      void cache.invalidateQueries({ queryKey: ["investigations", projectId] });
      navigate(inv.browserPath);
    },
  });
  const ci = useMutation({
    mutationFn: (url: string) => investigations.resolveCi(projectId, url),
    onSuccess: (revision) => {
      setCommit(revision.commit);
      setUseCiLink(false);
      fresh();
    },
  });
  const setupLabel =
    githubSetup.data?.state === "AWAITING_MERGE"
      ? "Merge the setup pull request"
      : githubSetup.data?.previousWorkflow
        ? "Update the GitHub workflow"
        : "Set up test execution";

  const recent = (
    <section className="stack">
      <div className="section-head">
        <h2 className="section-title">Recent</h2>
        <Link className="text-link" to="/agents">
          Use with your agent
        </Link>
      </div>
      {q.isPending ? (
        <Spinner label="Loading investigations…" />
      ) : q.isError ? (
        <div className="stack">
          <ErrorMessage error={q.error} />
          <div>
            <button className="btn" onClick={() => void q.refetch()}>
              Try again
            </button>
          </div>
        </div>
      ) : q.data.items.length ? (
        <div className="list">
          {q.data.items.map((i) => (
            <Link to={i.browserPath} key={i.id} className="row link">
              <div className="row-main">
                <strong className="truncate">{i.question}</strong>
                <span className="muted truncate">
                  {[kindLabel(i), formatTime(i.createdAt)].join(" · ")}
                </span>
              </div>
              <State value={listStatus(i)} />
              <Icon name="chevron-right" />
            </Link>
          ))}
        </div>
      ) : (
        <p className="muted">
          Nothing yet. Investigations you start here or from your coding agent show up in this list.
        </p>
      )}
    </section>
  );

  return (
    <div className="page">
      <PageHeader
        eyebrow={project?.repository ?? undefined}
        title="Reproduce a failing test"
        description="Run the exact test that failed, at the commit where it failed. Then check your fix against it."
      />
      {handoff && !prefill && (
        <div className="notice">
          <Icon name="alert" />
          <span>
            This CI failure belongs to <strong>{ciRepository}</strong>.
            {!ciProject && " Connect that repository, then open the CI link again."}
          </span>
          {ciProject && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                const target = new URLSearchParams(params);
                target.set("project", ciProject.id);
                navigate("/investigations?" + target.toString());
              }}
            >
              Open repository
            </button>
          )}
        </div>
      )}
      {!project?.repository ? (
        <div className="stack-xl">
          <Empty
            title="Start with a repository"
            action={
              <button className="btn primary" onClick={openConnect}>
                <GitHubMark /> Connect repository
              </button>
            }
          >
            Traceyard reads the code, finds your tests and runs them where your CI already does. No
            keys to copy.
          </Empty>
          {!!q.data?.items.length && recent}
        </div>
      ) : (
        <div className="stack-xl">
          <form
            className="card composer"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            {!ready && !checkingSetup && (
              <div className="notice">
                <Icon name="alert" />
                <span>
                  {usesGitHub
                    ? "Tests run in your GitHub Actions. Merge one small workflow file to turn this on."
                    : "Running tests isn’t available on this server yet."}
                </span>
                {usesGitHub && (
                  <button type="button" className="btn" onClick={() => setSetup(true)}>
                    {setupLabel}
                  </button>
                )}
              </div>
            )}
            <ErrorMessage error={catalog.error || githubSetup.error} />

            {checkingSetup ? (
              <Spinner label="Checking setup…" />
            ) : (
              ready && (
                <div className="stack">
                  <TestFileField
                    projectId={projectId}
                    required
                    value={testPath}
                    onChange={(value) => {
                      setTestPath(value);
                      setTestCase("");
                      fresh();
                    }}
                  />
                  {python && (
                    <PytestCaseField
                      value={testCase}
                      onChange={(value) => {
                        setTestCase(value);
                        fresh();
                      }}
                    />
                  )}
                  {useCiLink ? (
                    <div className="field">
                      <span className="field-label">GitHub Actions link</span>
                      <div className="inline-field">
                        <input
                          id="investigation-ci-link"
                          aria-label="GitHub Actions link"
                          placeholder="https://github.com/owner/repo/actions/runs/…"
                          value={ciUrl}
                          onChange={(e) => {
                            setCiUrl(e.target.value);
                            ci.reset();
                          }}
                          disabled={ci.isPending}
                        />
                        <button
                          type="button"
                          className="btn"
                          disabled={!ciUrl.trim() || ci.isPending}
                          onClick={() => ci.mutate(ciUrl.trim())}
                        >
                          {ci.isPending ? "Reading…" : "Use this run"}
                        </button>
                      </div>
                      <span className="field-hint">
                        Paste the link to the failed run. Traceyard reads the commit from it.{" "}
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setUseCiLink(false)}
                        >
                          Enter the commit instead
                        </button>
                      </span>
                      <ErrorMessage error={ci.error} />
                    </div>
                  ) : (
                    <label className="field">
                      <span className="field-label">Commit where it failed</span>
                      <input
                        id="investigation-commit"
                        className="mono"
                        required
                        value={commit}
                        pattern={SHA}
                        maxLength={40}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder="Full commit SHA"
                        onChange={(e) => {
                          setCommit(e.target.value.trim().toLowerCase());
                          fresh();
                        }}
                      />
                      <span className="field-hint">
                        {prefill
                          ? "Filled in from CI. Check it before running."
                          : ci.data && ci.data.commit === commit
                            ? "Taken from the GitHub Actions run."
                            : "It has to be pushed to GitHub."}{" "}
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setUseCiLink(true)}
                        >
                          Paste a GitHub Actions link instead
                        </button>
                      </span>
                    </label>
                  )}
                </div>
              )
            )}

            <ErrorMessage error={create.error} />
            <div className="composer-foot">
              <span className="muted">{usesGitHub ? "Uses your GitHub Actions minutes." : ""}</span>
              <button
                className="btn primary"
                disabled={create.isPending || ci.isPending || useCiLink || !ready}
              >
                {create.isPending ? "Starting…" : "Run test"}
                <Icon name={create.isPending ? "spinner" : "arrow-right"} />
              </button>
            </div>
          </form>

          {recent}
        </div>
      )}
      {setup && (
        <EnableGitHubChecks
          projectId={projectId}
          close={() => setSetup(false)}
          onReady={() => {
            setSetup(false);
            void catalog.refetch();
          }}
        />
      )}
    </div>
  );
}

function Evidence({
  projectId,
  id,
  evidenceId,
}: {
  projectId: string;
  id: string;
  evidenceId: string;
}) {
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ["investigation-evidence", projectId, id, evidenceId, offset],
    queryFn: () => investigations.evidence(projectId, id, evidenceId, offset),
  });
  if (q.isPending) return <Spinner label="Loading evidence…" />;
  if (q.isError) return <ErrorMessage error={q.error} />;
  const more = q.data.nextOffset !== null;
  return (
    <div className="stack-sm">
      <pre className="code">{q.data.text}</pre>
      {(offset > 0 || more) && (
        <div className="pager">
          <button
            className="btn"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 3000))}
          >
            Previous
          </button>
          <span className="muted">{more ? "More below" : "End of evidence"}</span>
          <button className="btn" disabled={!more} onClick={() => setOffset(q.data.nextOffset!)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

export function InvestigationPage() {
  const { id } = useParams();
  return <InvestigationDetail key={id} />;
}

function InvestigationDetail() {
  const { id = "" } = useParams(),
    { projectId } = useWorkspace(),
    cache = useQueryClient(),
    navigate = useNavigate(),
    [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState(params.get("evidence") ?? ""),
    [commit, setCommit] = useState(""),
    [flakeCommit, setFlakeCommit] = useState<string | null>(null),
    [setup, setSetup] = useState(false);
  const q = useQuery({
    queryKey: ["investigation", projectId, id],
    queryFn: () => investigations.get(projectId, id),
    refetchInterval: (q) => (busy(q.state.data) ? 5000 : false),
  });
  const update = (i: Investigation) => {
    cache.setQueryData(["investigation", projectId, id], i);
    void cache.invalidateQueries({ queryKey: ["investigations", projectId] });
  };
  const cancel = useMutation({
    mutationFn: () => investigations.cancel(projectId, id),
    onSuccess: update,
  });
  const replay = useMutation({
    mutationFn: (recordingId: string) =>
      investigations.create(projectId, {
        question: q.data!.question,
        mode: "replay",
        recordingId,
        requestKey: newIdempotencyKey(),
      }),
    onSuccess: (i) => navigate(i.browserPath),
  });
  const verificationId = params.get("verification") ?? q.data?.verifications?.[0]?.id ?? "";
  const verification = useQuery({
    queryKey: ["verification", projectId, verificationId],
    queryFn: () => investigations.verification(projectId, verificationId),
    enabled: !!verificationId,
    refetchInterval: (q) => (q.state.data?.verdict === "PENDING" ? 5000 : false),
  });
  const verify = useMutation({
    mutationFn: () => investigations.verify(projectId, id, commit),
    onSuccess: (v) => {
      cache.setQueryData(["verification", projectId, v.id], v);
      const next = new URLSearchParams(params);
      next.set("verification", v.id);
      setParams(next);
    },
  });
  const flake = useMutation({
    mutationFn: () =>
      investigations.flakiness(
        projectId,
        id,
        flakeCommit ?? verification.data?.candidateCommit ?? commit,
        q.data!.execution!.command.testPath!,
      ),
    onSuccess: (run) => navigate(run.browserPath),
  });

  if (q.isPending) return <Spinner label="Loading investigation…" />;
  if (q.isError)
    return (
      <div className="page stack">
        <BackLink />
        <ErrorMessage error={q.error} />
        <div>
          <button className="btn" onClick={() => void q.refetch()}>
            Try again
          </button>
        </div>
      </div>
    );

  const i = q.data,
    running = busy(i),
    failed =
      i.execution?.status === "FAILED" &&
      !!i.execution.counts.failed &&
      i.execution.failures.some((failure) => failure.file === i.execution?.command.testPath);
  const didNotReproduce =
    i.execution?.status === "SUCCEEDED" && !i.execution.flakeRuns && !verificationId;
  const python = i.execution?.command.testPath?.endsWith(".py");
  const earlierFailure = i.attempts?.some((attempt) => attempt.status === "FAILED");
  const flakePrompt =
    didNotReproduce ||
    (verification.data?.label === "Inconclusive" &&
      verification.data.candidateRun?.status === "SUCCEEDED");
  const flakeResults = !!i.execution?.flakeRuns;
  const isCandidate = id === verification.data?.candidateId;
  const overview = isOverview(i);
  const output = overview ? [] : i.evidence;
  const evidenceHref = (runId: string, evidenceId?: string | null) =>
    `/investigations/${runId}?project=${encodeURIComponent(projectId)}${evidenceId ? `&evidence=${encodeURIComponent(evidenceId)}#evidence` : ""}`;

  return (
    <div className="page">
      <BackLink />
      <PageHeader
        eyebrow={flakeResults ? "Flakiness check" : kindLabel(i)}
        title={<span className="clamp-2">{i.question}</span>}
        description={
          <span className="meta">
            {i.snapshot.repository && <span>{i.snapshot.repository}</span>}
            {i.snapshot.commit && (
              <code title={i.snapshot.commit}>{shortSha(i.snapshot.commit)}</code>
            )}
          </span>
        }
        actions={
          !flakeResults &&
          !overview && (
            <State
              value={
                verification.data?.verdict === "PASSED"
                  ? "PASSED"
                  : i.status === "EVIDENCE_READY"
                    ? (i.execution?.status ?? (overview ? "OVERVIEW" : i.status))
                    : i.status
              }
            />
          )
        }
      />
      <div className="stack-lg">
        <section className="card stack" aria-labelledby="finding-title">
          <h2 id="finding-title">
            {running ? "Running the test" : overview ? "What Traceyard found" : "What happened"}
          </h2>
          {(!i.execution || running || i.status !== "EVIDENCE_READY") && (
            <p className="finding">
              {running ? "Waiting for the result. You can leave this page." : i.finding.summary}
            </p>
          )}
          {i.execution && <ExecutionSummary execution={i.execution} />}
          {didNotReproduce && (
            <div className="notice">
              <Icon name="alert" />
              <span>
                <strong>The test passed this time.</strong>{" "}
                {earlierFailure
                  ? "It failed on an earlier attempt, so it may be flaky."
                  : python
                    ? "Check the commit and the test name."
                    : "Check the commit and the test file."}
              </span>
            </div>
          )}
          {overview && <TestsFound projectId={projectId} />}
          {i.finding.nextAction && !running && !i.execution && !overview && (
            <p className="muted">{i.finding.nextAction}</p>
          )}
          {(running || (i.status === "BLOCKED" && i.finding.code === "CI_SETUP_REQUIRED")) && (
            <div className="actions">
              {running && (
                <button className="btn" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                  {cancel.isPending ? "Cancelling…" : "Cancel"}
                </button>
              )}
              {i.status === "BLOCKED" && i.finding.code === "CI_SETUP_REQUIRED" && (
                <button className="btn primary" onClick={() => setSetup(true)}>
                  Set up test execution
                </button>
              )}
            </div>
          )}
          <ErrorMessage error={cancel.error} />
        </section>

        {verificationId && (
          <section className="card stack" aria-labelledby="verification-title">
            <div className="section-head">
              <h2 id="verification-title">Your fix</h2>
              {verification.data && (
                <Badge tone={STATE[verification.data.verdict]?.[1] ?? "neutral"}>
                  {verification.data.label}
                </Badge>
              )}
            </div>
            {verification.isPending ? (
              <Spinner label="Loading verification…" />
            ) : verification.isError ? (
              <ErrorMessage error={verification.error} />
            ) : (
              <>
                <p>{verification.data.summary}</p>
                <div className="compare">
                  {[
                    {
                      name: "Before",
                      run: verification.data.baselineRun,
                      runId: verification.data.baselineId,
                      fallback: "No retained run",
                    },
                    {
                      name: "After",
                      run: verification.data.candidateRun,
                      runId: verification.data.candidateId,
                      fallback: verification.data.candidateCommit,
                    },
                  ].map(({ name, run, runId, fallback }) => (
                    <div className="compare-side" key={name}>
                      <div className="section-head">
                        <span className="field-label">{name}</span>
                        {run && <State value={run.status} />}
                      </div>
                      <code className="commit-id">{run?.commit ?? fallback}</code>
                      {run?.failure && <pre className="code">{run.failure.message}</pre>}
                      {run && (
                        <a
                          className="text-link"
                          aria-label={`Open ${name.toLowerCase()} evidence`}
                          href={evidenceHref(runId, run.evidenceId)}
                        >
                          See output
                        </a>
                      )}
                    </div>
                  ))}
                </div>
                {verification.data.changedTests.length > 0 && (
                  <div className="notice">
                    <Icon name="alert" />
                    <span>
                      The fix also changed {verification.data.changedTests.length} test{" "}
                      {verification.data.changedTests.length === 1 ? "file" : "files"}. Check that
                      the test still tests the right thing:{" "}
                      {verification.data.changedTests.map((path, n) => (
                        <span key={path}>
                          {n > 0 && ", "}
                          <code>{path}</code>
                        </span>
                      ))}
                    </span>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {failed && !running && !flakeResults && !isCandidate && (
          <form
            id="verify"
            className="card stack"
            onSubmit={(e) => {
              e.preventDefault();
              verify.mutate();
            }}
          >
            <div>
              <h2>{verificationId ? "Try another fix" : "Verify a fix"}</h2>
              <p className="muted">
                Push your fix to GitHub and paste its commit here. Traceyard runs the same test
                again.
              </p>
            </div>
            <div className="inline-field">
              <input
                aria-label="Fix commit"
                className="mono"
                required
                pattern={SHA}
                maxLength={40}
                spellCheck={false}
                autoComplete="off"
                value={commit}
                onChange={(e) => setCommit(e.target.value.trim().toLowerCase())}
                placeholder="Commit SHA of your fix"
              />
              <button className="btn primary" disabled={verify.isPending}>
                {verify.isPending ? "Starting…" : "Verify"}
              </button>
            </div>
            <ErrorMessage error={verify.error} />
          </form>
        )}

        {flakePrompt &&
          !running &&
          !flakeResults &&
          !python &&
          i.execution?.command.testPath &&
          i.snapshot.commit &&
          i.status === "EVIDENCE_READY" &&
          !isCandidate && (
            <form
              className="card stack"
              onSubmit={(e) => {
                e.preventDefault();
                flake.mutate();
              }}
            >
              <div>
                <h2>Check if it’s flaky</h2>
                <p className="muted">
                  Runs the test 3 times at the failing commit and 3 times at your fix. Takes about
                  10 minutes.
                </p>
              </div>
              <div className="inline-field">
                <input
                  aria-label="Candidate commit for flakiness check"
                  className="mono"
                  required
                  pattern={SHA}
                  maxLength={40}
                  spellCheck={false}
                  value={flakeCommit ?? verification.data?.candidateCommit ?? commit}
                  placeholder="Commit SHA of your fix"
                  onChange={(e) => setFlakeCommit(e.target.value.trim().toLowerCase())}
                />
                <button className="btn" disabled={flake.isPending}>
                  Run 6 times
                </button>
              </div>
              <ErrorMessage error={flake.error} />
            </form>
          )}

        {!!output.length && (
          <section className="stack" id="evidence">
            <h2 className="section-title">Output</h2>
            <div className="list">
              {output.map((e) => (
                <div key={e.id} className="row-group">
                  <button
                    className="row link"
                    aria-expanded={selected === e.id}
                    onClick={() => setSelected(selected === e.id ? "" : e.id)}
                  >
                    <span className="chevron">
                      <Icon name="chevron-right" />
                    </span>
                    <div className="row-main">
                      <strong className="truncate">{outputTitle(e.title)}</strong>
                    </div>
                    <span className="muted">{selected === e.id ? "Hide" : "Show"}</span>
                  </button>
                  {selected === e.id && (
                    <div className="row-panel">
                      <Evidence key={e.id} projectId={projectId} id={id} evidenceId={e.id} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {i.recordings?.map((r) => (
          <section className="card setting-row" key={r.id}>
            <div>
              <h2>Recorded network calls</h2>
              <p className="muted">
                {r.eligible
                  ? "This test can run again offline using the recorded responses."
                  : "This recording is incomplete, so it can’t be replayed."}
              </p>
              <ErrorMessage error={replay.error} />
            </div>
            {r.eligible && (
              <button
                className="btn"
                disabled={replay.isPending}
                onClick={() => replay.mutate(r.id)}
              >
                Replay
              </button>
            )}
          </section>
        ))}

        {(i.attempts?.length ?? 0) > 1 && (
          <section className="stack">
            <h2 className="section-title">Attempts</h2>
            <div className="list">
              {i.attempts!.map((a, n) => (
                <div className="row" key={a.id}>
                  <div className="row-main">
                    <strong>Attempt {n + 1}</strong>
                    <span className="muted">{formatTime(a.createdAt)}</span>
                  </div>
                  {a.checkId && (
                    <Link
                      className="text-link"
                      to={`${repositoryPath(projectId)}/checks/${encodeURIComponent(a.checkId)}`}
                    >
                      View run
                    </Link>
                  )}
                  <State value={a.status} />
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      {setup && (
        <EnableGitHubChecks
          projectId={projectId}
          close={() => setSetup(false)}
          onReady={() => {
            setSetup(false);
            void cache.invalidateQueries({ queryKey: ["catalog", projectId] });
          }}
        />
      )}
    </div>
  );
}

const OUTPUT_TITLES: Record<string, string> = {
  "Focused test execution": "Full test output",
  "Flakiness attempts": "Output from every attempt",
  "Reported repository check": "Check log",
  "Recorded trace spans": "Recorded trace",
};
const outputTitle = (title: string) => OUTPUT_TITLES[title] ?? title;

/** Tests the repository index found, each one tap away from a run. */
function TestsFound({ projectId }: { projectId: string }) {
  const [all, setAll] = useState(false);
  const index = useQuery({
    queryKey: ["indexed-tests", projectId],
    queryFn: () =>
      integrationRequest<{ files: { path: string }[]; truncated: boolean } | null>(
        projectId,
        "repository/index?kind=tests",
      ),
  });
  if (index.isPending) return <Spinner label="Loading tests…" />;
  if (index.isError) return <ErrorMessage error={index.error} />;
  const files = index.data?.files ?? [];
  if (!files.length) return null;
  const shown = all ? files : files.slice(0, 5);
  return (
    <div className="stack-sm">
      <span className="field-label">Tests you can run</span>
      <div className="list">
        {shown.map((f) => (
          <Link
            key={f.path}
            className="row link"
            to={"/investigations?test=" + encodeURIComponent(f.path)}
          >
            <code className="row-main truncate">{f.path}</code>
            <span className="row-action">
              Run
              <Icon name="arrow-right" />
            </span>
          </Link>
        ))}
        {!all && files.length > shown.length && (
          <button className="row row-more" onClick={() => setAll(true)}>
            Show {files.length - shown.length} more
          </button>
        )}
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link className="back" to="/investigations">
      <Icon name="arrow-left" />
      Investigations
    </Link>
  );
}
