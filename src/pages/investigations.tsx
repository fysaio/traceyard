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
  EVIDENCE_READY: ["Evidence ready", "neutral"],
  EXECUTING: ["Running", "running"],
  ANALYZING: ["Analyzing", "running"],
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
          ? "Suggestions show the first 100 indexed tests. Any path from the repository root works."
          : required
            ? "Path from the repository root. Vitest, Jest and Pytest are supported."
            : "Leave blank to let Traceyard pick the closest test."}
      </span>
      <ErrorMessage error={index.error} />
    </label>
  );
}

function PytestCaseField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">Pytest case (optional)</span>
      <input
        className="mono"
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        maxLength={240}
        placeholder="TestCheckout::test_total[wallet]"
      />
      <span className="field-hint">
        The part after the file in the node ID. Blank runs the whole file.
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
  const [question, setQuestion] = useState(""),
    [mode, setMode] = useState<"execute" | "analyze">("execute"),
    [capture, setCapture] = useState(false),
    [testPath, setTestPath] = useState(prefill ? (ciTest ?? "") : ""),
    [testCase, setTestCase] = useState(prefill ? (ciCase ?? "") : ""),
    [commit, setCommit] = useState(prefill ? (ciCommit ?? "") : ""),
    [ciUrl, setCiUrl] = useState(""),
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
        question: question.trim() || `Reproduce ${testPath}`,
        mode,
        captureInteractions: mode === "execute" && capture && !python,
        testPath: mode === "execute" ? testPath || undefined : undefined,
        testCase: mode === "execute" && python ? testCase.trim() || undefined : undefined,
        expectedRepository: project?.repository ?? undefined,
        commit: mode === "execute" ? commit || undefined : undefined,
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
          Run these from your coding agent
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
                  {[
                    shortSha(i.snapshot.commit),
                    i.finding.basis === "observed" ? "Test run" : "Code analysis",
                    formatTime(i.createdAt),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <State value={i.status} />
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
            <div className="composer-head">
              <div className="segmented" role="group" aria-label="Investigation mode">
                {(
                  [
                    ["execute", "Run a test"],
                    ["analyze", "Ask about the code"],
                  ] as const
                ).map(([value, name]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={mode === value}
                    onClick={() => {
                      setMode(value);
                      fresh();
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
              {mode === "execute" &&
                (checkingSetup ? (
                  <span className="muted">Checking setup…</span>
                ) : ready ? (
                  <Badge tone="pass">Ready to run</Badge>
                ) : null)}
            </div>

            {mode === "execute" && !ready && !checkingSetup && (
              <div className="notice">
                <Icon name="alert" />
                <span>
                  {usesGitHub
                    ? "Tests run in your GitHub Actions. Merge one small workflow file to turn this on."
                    : "Hosted test execution isn’t available on this server. You can still ask about the code."}
                </span>
                {usesGitHub && (
                  <button type="button" className="btn" onClick={() => setSetup(true)}>
                    {setupLabel}
                  </button>
                )}
              </div>
            )}
            <ErrorMessage error={catalog.error || githubSetup.error} />

            {mode === "execute" && ready && (
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
                <label className="field">
                  <span className="field-label">Failing commit</span>
                  <input
                    id="investigation-commit"
                    className="mono"
                    required
                    value={commit}
                    pattern={SHA}
                    maxLength={40}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="Full 40-character SHA"
                    onChange={(e) => {
                      setCommit(e.target.value.trim().toLowerCase());
                      fresh();
                    }}
                  />
                  <span className="field-hint">
                    {prefill
                      ? "Filled in from CI. Review it before running."
                      : ci.data && ci.data.commit === commit
                        ? `${ci.data.kind} from the CI job checkout.`
                        : "The commit must be pushed. Local changes aren’t uploaded."}
                  </span>
                </label>
                <details className="disclosure">
                  <summary>
                    <Icon name="chevron-right" />
                    Use a GitHub Actions link instead
                  </summary>
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
                      {ci.isPending ? "Reading…" : "Use this commit"}
                    </button>
                  </div>
                  <ErrorMessage error={ci.error} />
                </details>
                {!python && (
                  <details className="disclosure">
                    <summary>
                      <Icon name="chevron-right" />
                      Record network calls for replay
                    </summary>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={capture}
                        onChange={(e) => {
                          setCapture(e.target.checked);
                          fresh();
                        }}
                      />
                      <span>
                        Keep supported JSON responses so the test can replay offline. Headers and
                        credentials are never stored.
                      </span>
                    </label>
                  </details>
                )}
              </div>
            )}

            {mode === "analyze" && (
              <label className="field">
                <span className="field-label">What should Traceyard look into?</span>
                <textarea
                  required
                  minLength={3}
                  maxLength={1000}
                  rows={3}
                  placeholder="Why does checkout submit the order twice on retry?"
                  value={question}
                  onChange={(e) => {
                    setQuestion(e.target.value);
                    fresh();
                  }}
                />
                <span className="field-hint">
                  Reads indexed code and saved evidence. Nothing is executed.
                </span>
              </label>
            )}

            <ErrorMessage error={create.error} />
            <div className="composer-foot">
              <span className="muted">
                {mode === "execute" && usesGitHub ? "Runs use your GitHub Actions minutes." : ""}
              </span>
              <button
                className="btn primary"
                disabled={create.isPending || ci.isPending || (mode === "execute" && !ready)}
              >
                {create.isPending ? "Starting…" : mode === "execute" ? "Run test" : "Investigate"}
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
    [testPath, setTestPath] = useState(""),
    [testCase, setTestCase] = useState(""),
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
  const execute = useMutation({
    mutationFn: () =>
      investigations.execute(
        projectId,
        id,
        testPath || undefined,
        testPath.endsWith(".py") ? testCase.trim() || undefined : undefined,
      ),
    onSuccess: update,
  });
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
  const limits = [...new Set([...i.snapshot.warnings, ...i.finding.limitations])];
  const evidenceHref = (runId: string, evidenceId?: string | null) =>
    `/investigations/${runId}?project=${encodeURIComponent(projectId)}${evidenceId ? `&evidence=${encodeURIComponent(evidenceId)}#evidence` : ""}`;

  return (
    <div className="page">
      <BackLink />
      <PageHeader
        eyebrow={flakeResults ? "Flakiness check" : "Investigation"}
        title={<span className="clamp-2">{i.question}</span>}
        description={
          <span className="meta">
            {i.snapshot.repository && <span>{i.snapshot.repository}</span>}
            <code title={i.snapshot.commit ?? "Unknown revision"}>
              {shortSha(i.snapshot.commit, 12) ?? "revision unknown"}
            </code>
            {!!i.snapshot.filesScanned && (
              <span>{i.snapshot.filesScanned.toLocaleString()} files indexed</span>
            )}
          </span>
        }
        actions={
          !flakeResults && (
            <State
              value={i.status === "EVIDENCE_READY" && i.execution ? i.execution.status : i.status}
            />
          )
        }
      />
      <div className="stack-lg">
        <section className="card stack" aria-labelledby="finding-title">
          <h2 id="finding-title">{running ? "Running the test" : "What happened"}</h2>
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
                <strong>Inconclusive.</strong>{" "}
                {earlierFailure
                  ? "The latest run passed after an earlier failure."
                  : "The test passed at the failing commit."}{" "}
                {python
                  ? "Check the commit and the selected case."
                  : "Check the commit and test file, or check for flakiness below."}
              </span>
            </div>
          )}
          {i.finding.nextAction && !running && !i.execution && (
            <p className="muted">{i.finding.nextAction}</p>
          )}
          {(running ||
            (failed && !running && !verificationId) ||
            (i.status === "BLOCKED" && i.finding.code === "CI_SETUP_REQUIRED")) && (
            <div className="actions">
              {failed && !running && !verificationId && (
                <a className="btn primary" href="#verify">
                  Verify a fix
                  <Icon name="arrow-right" />
                </a>
              )}
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
              <h2 id="verification-title">Fix verification</h2>
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
                      <code>{(run?.commit ?? fallback)?.slice(0, 12)}</code>
                      {run && (
                        <>
                          <code className="muted">
                            {run.testPath}
                            {run.testCase && "::" + run.testCase}
                          </code>
                          {run.failure && <pre className="code">{run.failure.message}</pre>}
                          <a
                            className="text-link"
                            aria-label={`Open ${name.toLowerCase()} evidence`}
                            href={evidenceHref(runId, run.evidenceId)}
                          >
                            Open evidence
                          </a>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                {verification.data.changedTests.length > 0 && (
                  <div className="notice">
                    <Icon name="alert" />
                    <span>
                      The fix changed {verification.data.changedTests.length} test or fixture{" "}
                      {verification.data.changedTests.length === 1 ? "file" : "files"}:{" "}
                      {verification.data.changedTests.map((path, n) => (
                        <span key={path}>
                          {n > 0 && ", "}
                          <code>{path}</code>
                        </span>
                      ))}
                    </span>
                  </div>
                )}
                {verification.data.limitations.length > 0 && (
                  <ul className="bullets muted">
                    {verification.data.limitations.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
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
              <h2>Verify a fix</h2>
              <p className="muted">
                Push your fix, then paste its commit. Traceyard runs the same test under the same
                conditions.
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
                placeholder="Full 40-character SHA"
              />
              <button className="btn primary" disabled={verify.isPending}>
                {verify.isPending ? "Starting…" : "Verify"}
              </button>
            </div>
            <ErrorMessage error={verify.error} />
          </form>
        )}

        {!running &&
          !flakeResults &&
          !python &&
          i.execution?.command.testPath &&
          i.snapshot.commit &&
          i.status === "EVIDENCE_READY" &&
          !isCandidate && (
            <details className="card disclosure" open={flakePrompt || undefined}>
              <summary>
                <Icon name="chevron-right" />
                Check for flakiness
              </summary>
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  flake.mutate();
                }}
              >
                <p className="muted">
                  Runs the test three times at each commit, each from a fresh checkout. Takes up to
                  about 10 minutes plus queue time.
                </p>
                <div className="inline-field">
                  <input
                    aria-label="Candidate commit for flakiness check"
                    className="mono"
                    required
                    pattern={SHA}
                    maxLength={40}
                    spellCheck={false}
                    value={flakeCommit ?? verification.data?.candidateCommit ?? commit}
                    placeholder="Fix commit SHA"
                    onChange={(e) => setFlakeCommit(e.target.value.trim().toLowerCase())}
                  />
                  <button className="btn" disabled={flake.isPending}>
                    Run 6 attempts
                  </button>
                </div>
                <ErrorMessage error={flake.error} />
              </form>
            </details>
          )}

        {!!i.evidence.length && (
          <section className="stack" id="evidence">
            <h2 className="section-title">Evidence</h2>
            <div className="list">
              {i.evidence.map((e) => (
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
                      <strong className="truncate">{e.title}</strong>
                    </div>
                    <span className="muted">
                      {e.basis === "observed" ? "Recorded" : "Source"}
                      {e.truncated ? " · truncated" : ""}
                    </span>
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
                  ? "This test can replay offline using the recorded responses."
                  : "This recording is incomplete, so it can’t replay."}
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

        {(limits.length > 0 ||
          !!i.attempts?.length ||
          (!running && !flakeResults && i.status !== "CANCELLED")) && (
          <div className="stack-sm">
            {limits.length > 0 && (
              <details className="disclosure">
                <summary>
                  <Icon name="chevron-right" />
                  Limits of this evidence ({limits.length})
                </summary>
                <ul className="bullets muted">
                  {limits.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </details>
            )}
            {!running && !flakeResults && i.status !== "CANCELLED" && (
              <details className="disclosure">
                <summary>
                  <Icon name="chevron-right" />
                  Run another test in this investigation
                </summary>
                <form
                  className="stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    execute.mutate();
                  }}
                >
                  <TestFileField
                    projectId={projectId}
                    value={testPath}
                    onChange={(path) => {
                      setTestPath(path);
                      setTestCase("");
                    }}
                  />
                  {testPath.endsWith(".py") && (
                    <PytestCaseField value={testCase} onChange={setTestCase} />
                  )}
                  <div className="composer-foot">
                    <span className="muted">
                      {3 - (i.attempts?.length ?? 0)} of 3 attempts left
                    </span>
                    <button
                      className="btn"
                      disabled={execute.isPending || (i.attempts?.length ?? 0) >= 3}
                    >
                      Run test
                    </button>
                  </div>
                  <ErrorMessage error={execute.error} />
                </form>
              </details>
            )}
            {!!i.attempts?.length && (
              <details className="disclosure">
                <summary>
                  <Icon name="chevron-right" />
                  Run history ({i.attempts.length})
                </summary>
                <div className="list">
                  {i.attempts.map((a) => (
                    <div className="row" key={a.id}>
                      <div className="row-main">
                        <code className="muted truncate">{a.id}</code>
                      </div>
                      {a.checkId && (
                        <Link
                          className="text-link"
                          to={`${repositoryPath(projectId)}/checks/${encodeURIComponent(a.checkId)}`}
                        >
                          Check
                        </Link>
                      )}
                      <State value={a.status} />
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
        <p className="muted mono small">{i.id}</p>
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

function BackLink() {
  return (
    <Link className="back" to="/investigations">
      <Icon name="arrow-left" />
      Investigations
    </Link>
  );
}
