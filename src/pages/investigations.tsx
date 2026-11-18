import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ProjectLink as Link } from "../components/project-link";
import { ErrorMessage, Icon, Modal } from "../components/product-ui";
import { useWorkspace } from "../lib/workspace";
import { investigations } from "../lib/investigations-api";
import { integrationRequest } from "../lib/integrations-api";
import { newIdempotencyKey } from "../lib/api";
import { ConnectRepository } from "./project-overview";
import { EnableGitHubChecks } from "./project-experience";
import type { Investigation } from "../../shared/contracts/investigations";
import type { Catalog } from "../../shared/repository/workspace";
import { ExecutionSummary } from "../components/execution-summary";

function ExistingTest({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
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
    <label>
      Existing test (optional)
      <input
        list="indexed-tests"
        value={value}
        maxLength={300}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Inferred from your question when possible"
      />
      <datalist id="indexed-tests">
        {index.data?.files.map((f) => (
          <option key={f.path} value={f.path} />
        ))}
      </datalist>
      <span className="hint">
        {index.data?.truncated
          ? "Showing the first 100 indexed tests. You can enter another existing path."
          : "Select an indexed test or let Traceyard infer it."}
      </span>
      <ErrorMessage error={index.error} />
    </label>
  );
}
function State({ value }: { value: string }) {
  const labels: Record<string, string> = {
    EVIDENCE_READY: "Evidence ready",
    EXECUTING: "Running",
    ANALYZING: "Analyzing",
    PASSED: "Repair verified",
    REVIEW_TEST_CHANGES: "Review test changes",
    INCONCLUSIVE: "Needs review",
    BLOCKED: "Needs attention",
    CANCELLED: "Cancelled",
    SUCCEEDED: "Passed",
    FAILED: "Failed",
  };
  return (
    <span className={"status " + value.toLowerCase()}>
      {labels[value] ?? value.toLowerCase().replaceAll("_", " ")}
    </span>
  );
}
const busy = (i: Investigation | undefined) =>
  i?.status === "EXECUTING" || i?.status === "ANALYZING";
export function InvestigationsPage() {
  const { projectId, projects } = useWorkspace(),
    navigate = useNavigate(),
    cache = useQueryClient();
  const project = projects.find((p) => p.id === projectId);
  const [question, setQuestion] = useState(""),
    [mode, setMode] = useState<"execute" | "analyze">("execute"),
    [capture, setCapture] = useState(false),
    [testPath, setTestPath] = useState(""),
    [commit, setCommit] = useState(""),
    [connect, setConnect] = useState(false),
    [key, setKey] = useState(newIdempotencyKey);
  const catalog = useQuery({
    queryKey: ["catalog", projectId],
    queryFn: () => integrationRequest<Catalog>(projectId, "catalog"),
    enabled: !!project?.repository,
  });
  const ready =
    catalog.data?.executionAvailable &&
    (catalog.data.executionProvider === "managed" || catalog.data.repository?.runner_enabled !== 0);
  const q = useQuery({
    queryKey: ["investigations", projectId],
    queryFn: () => investigations.list(projectId),
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.items.some(busy) ? 5000 : false),
  });
  const create = useMutation({
    mutationFn: () =>
      investigations.create(projectId, {
        question,
        mode,
        captureInteractions: mode === "execute" && capture,
        testPath: mode === "execute" ? testPath || undefined : undefined,
        expectedRepository: project?.repository ?? undefined,
        commit: mode === "execute" ? commit || undefined : undefined,
        requestKey: key,
      }),
    onSuccess: (inv) => {
      void cache.invalidateQueries({ queryKey: ["investigations", projectId] });
      navigate(inv.browserPath);
    },
  });
  return (
    <div className="investigation-home">
      <div className="page-head">
        <div>
          <p className="eyebrow">{project?.repository ?? project?.name ?? "Your workspace"}</p>
          <h1>What’s breaking?</h1>
          <p>
            Investigate your code here or from your coding agent. Every result stays with its source
            revision.
          </p>
        </div>
        <Link to="/connections" className="btn">
          <Icon name="plug" /> Project setup
        </Link>
      </div>
      {!project?.repository ? (
        <section className="investigation-connect connected-panel">
          <Icon name="code-branch" />
          <h2>Start with your repository</h2>
          <p>Choose it from GitHub. Traceyard reads the code and finds existing checks.</p>
          <button className="btn primary" onClick={() => setConnect(true)}>
            Connect repository
          </button>
          <p className="hint">
            Your app stays where it is. No provider keys to copy into Traceyard.
          </p>
        </section>
      ) : (
        <>
          <div className="readiness-strip">
            <span>
              <Icon name="code-branch" />
              {project.repository}
            </span>
            <span>
              <span className={ready ? "readiness-dot ready" : "readiness-dot"} />
              {catalog.isPending
                ? "Checking test execution…"
                : ready
                  ? "Test execution enabled"
                  : "Test execution needs setup"}
            </span>
            {!ready && !catalog.isPending && (
              <Link className="text-link" to="/connections">
                Finish setup <Icon name="arrow-right" />
              </Link>
            )}
          </div>
          <ErrorMessage error={catalog.error} />
          <form
            className="investigation-composer connected-panel"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <label htmlFor="investigation-question">Describe the problem</label>
            <textarea
              id="investigation-question"
              required
              minLength={3}
              maxLength={1000}
              rows={3}
              placeholder="Why does the checkout test fail after a retry?"
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
                setKey(newIdempotencyKey());
              }}
            />
            <div className="investigation-submit">
              <div className="segmented" role="group" aria-label="Investigation mode">
                {(
                  [
                    ["execute", "Run a focused test"],
                    ["analyze", "Inspect evidence"],
                  ] as const
                ).map(([value, name]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={mode === value}
                    className={mode === value ? "selected" : ""}
                    onClick={() => {
                      setMode(value);
                      setKey(newIdempotencyKey());
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <button
                className="btn primary"
                disabled={create.isPending || (mode === "execute" && !ready)}
              >
                {create.isPending ? "Starting…" : "Investigate"}
                <Icon name="arrow-right" />
              </button>
            </div>
            <p className="hint">
              {mode === "execute"
                ? "Runs an existing test using your connected executor. GitHub execution uses your Actions allowance."
                : "Reads retained code and runtime evidence without running your application."}
            </p>
            {mode === "execute" && !ready && !catalog.isPending && (
              <p className="hint">
                You can inspect source evidence now, or{" "}
                <Link className="text-link" to="/connections">
                  enable test execution
                </Link>{" "}
                first.
              </p>
            )}
            <details className="disclosure">
              <summary>Test and recording options</summary>
              <ExistingTest
                projectId={projectId}
                value={testPath}
                onChange={(value) => {
                  setTestPath(value);
                  setKey(newIdempotencyKey());
                }}
              />
              <label htmlFor="investigation-commit">Source commit (optional)</label>
              <input
                id="investigation-commit"
                value={commit}
                disabled={mode !== "execute"}
                pattern="[a-f0-9]{40}"
                maxLength={40}
                placeholder="Full pushed commit SHA"
                onChange={(e) => {
                  setCommit(e.target.value.trim());
                  setKey(newIdempotencyKey());
                }}
              />
              <p className="hint">
                Leave empty to use the indexed repository revision. A pushed commit selects another
                revision; local edits are not uploaded.
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={capture}
                  disabled={mode !== "execute"}
                  onChange={(e) => {
                    setCapture(e.target.checked);
                    setKey(newIdempotencyKey());
                  }}
                />{" "}
                Retain supported JSON interactions for isolated replay
              </label>
              <p className="hint">
                Optional capture retains application bodies. Headers and credential values are
                omitted. Incomplete recordings cannot replay.
              </p>
            </details>
            <ErrorMessage error={create.error} />
          </form>
        </>
      )}
      <section className="section">
        <div className="section-head">
          <h2>Recent investigations</h2>
          <Link className="text-link" to="/connections">
            Use your coding agent
          </Link>
        </div>
        {q.isPending ? (
          <p role="status">Loading investigations…</p>
        ) : q.isError ? (
          <>
            <ErrorMessage error={q.error} />
            <button className="btn" onClick={() => void q.refetch()}>
              Try again
            </button>
          </>
        ) : q.data.items.length ? (
          <div className="investigation-list">
            {q.data.items.map((i) => (
              <Link to={i.browserPath} key={i.id} className="investigation-row">
                <div>
                  <strong>{i.question}</strong>
                  <p>{i.finding.summary}</p>
                  <span className="hint">
                    {i.snapshot.commit ? i.snapshot.commit.slice(0, 7) : "Source revision unknown"}{" "}
                    · {i.finding.basis === "observed" ? "Recorded evidence" : "Source analysis"}
                  </span>
                  {i.createdAt && (
                    <time className="investigation-time" dateTime={i.createdAt}>
                      {new Date(i.createdAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  )}
                </div>
                <State value={i.status} />
                <Icon name="arrow-right" />
              </Link>
            ))}
          </div>
        ) : (
          <p className="hint">
            Your browser and coding agent share this history. Start an investigation here or connect
            the agent you already use.
          </p>
        )}
      </section>
      {connect && (
        <ConnectRepository
          destination="investigate"
          mode="github"
          close={() => setConnect(false)}
          connected={() => {
            setConnect(false);
            void cache.invalidateQueries({ queryKey: ["projects"] });
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
  return (
    <div className="evidence-reader">
      {q.isPending ? (
        <p role="status">Loading evidence…</p>
      ) : q.isError ? (
        <ErrorMessage error={q.error} />
      ) : (
        <>
          <pre className="code">{q.data.text}</pre>
          <div className="actions">
            <button
              className="btn"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 3000))}
            >
              Previous portion
            </button>
            <span className="hint">
              Offset {q.data.offset}
              {q.data.nextOffset !== null
                ? " · More retained evidence"
                : " · End of retained evidence"}
            </span>
            <button
              className="btn"
              disabled={q.data.nextOffset === null}
              onClick={() => setOffset(q.data!.nextOffset!)}
            >
              Next portion
            </button>
          </div>
        </>
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
  const [selected, setSelected] = useState(""),
    [testPath, setTestPath] = useState(""),
    [commit, setCommit] = useState("");
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
    mutationFn: () => investigations.execute(projectId, id, testPath || undefined),
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
  if (q.isPending) return <p role="status">Loading investigation…</p>;
  if (q.isError)
    return (
      <>
        <Link to="/investigations">← Investigations</Link>
        <ErrorMessage error={q.error} />
        <button className="btn" onClick={() => void q.refetch()}>
          Try again
        </button>
      </>
    );
  const i = q.data,
    failed = i.attempts?.some((a) => a.status === "FAILED");
  return (
    <div className="investigation-detail">
      <Link className="back" to="/investigations">
        ← Investigations
      </Link>
      <div className="page-head">
        <div>
          <h1>{i.question}</h1>
          <p className="hint">{i.id}</p>
        </div>
        <State
          value={i.status === "EVIDENCE_READY" && i.execution ? i.execution.status : i.status}
        />
      </div>
      <section className="connected-panel finding-panel" aria-labelledby="finding-title">
        <p className="eyebrow">
          {busy(i)
            ? "Execution in progress"
            : i.finding.basis === "observed"
              ? "Recorded finding"
              : "Source analysis"}
        </p>
        <h2 id="finding-title">{busy(i) ? "The focused check is running" : "What we found"}</h2>
        <p className="finding-summary">
          {busy(i)
            ? "Waiting for the current execution to report its result."
            : i.execution && i.status === "EVIDENCE_READY"
              ? `${i.execution.counts.passed} passed, ${i.execution.counts.failed} failed across the selected checks.`
              : i.finding.summary}
        </p>
        {i.execution && <ExecutionSummary execution={i.execution} />}
        {i.finding.nextAction && !busy(i) && <p>{i.finding.nextAction}</p>}
        {busy(i) && (
          <>
            <p role="status" className="hint">
              Results appear here automatically. You can leave and return to this investigation.
            </p>
            <button className="btn" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel investigation
            </button>
            <p className="hint">
              Cancellation closes this investigation. An external process may take until its timeout
              to stop.
            </p>
          </>
        )}
        {i.status === "BLOCKED" && (
          <Link className="btn" to="/connections">
            Review execution connection
          </Link>
        )}
        <ErrorMessage error={cancel.error} />
      </section>
      <div className="investigation-provenance">
        <span>{i.snapshot.repository ?? "No repository snapshot"}</span>
        <code title={i.snapshot.commit ?? "Unknown source revision"}>
          {i.snapshot.commit ? i.snapshot.commit.slice(0, 12) : "Revision unknown"}
        </code>
        <span>
          {i.snapshot.filesScanned
            ? `${i.snapshot.filesScanned} indexed files`
            : "No source index attached to this revision"}
        </span>
      </div>
      {[...i.snapshot.warnings, ...i.finding.limitations].length > 0 && (
        <details className="disclosure">
          <summary>Evidence and coverage limits</summary>
          <ul>
            {[...new Set([...i.snapshot.warnings, ...i.finding.limitations])].map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </details>
      )}
      {verificationId && (
        <section className="connected-panel section">
          <h2>Repair verification</h2>
          {verification.isPending ? (
            <p role="status">Loading verification…</p>
          ) : verification.isError ? (
            <ErrorMessage error={verification.error} />
          ) : (
            <>
              <State value={verification.data.verdict} />
              <p>{verification.data.summary}</p>
              <dl className="result-facts">
                <div>
                  <dt>Candidate revision</dt>
                  <dd>
                    <code title={verification.data.candidateCommit}>
                      {verification.data.candidateCommit.slice(0, 12)}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>Changed tests or fixtures</dt>
                  <dd>{verification.data.changedTests.length}</dd>
                </div>
              </dl>
              <Link
                className="btn"
                to={
                  "/investigations/" +
                  (id === verification.data.candidateId
                    ? verification.data.baselineId
                    : verification.data.candidateId)
                }
              >
                {id === verification.data.candidateId
                  ? "Open original failure"
                  : "Open candidate evidence"}
              </Link>
              {verification.data.changedTests.length > 0 && (
                <p>Changed tests or fixtures: {verification.data.changedTests.join(", ")}</p>
              )}
              <ul>
                {verification.data.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      <section className="section">
        <h2>Evidence</h2>
        {i.evidence.map((e) => (
          <div className="investigation-evidence" key={e.id}>
            <button
              className="evidence-toggle"
              aria-expanded={selected === e.id}
              onClick={() => setSelected(selected === e.id ? "" : e.id)}
            >
              <span>
                <strong>{e.title}</strong>
                <span className="hint">
                  {e.basis === "observed" ? "Recorded" : "Source"}
                  {e.truncated ? " · Truncated" : ""}
                </span>
              </span>
              <Icon name={selected === e.id ? "chevron-up" : "chevron-down"} />
            </button>
            {selected === e.id && (
              <Evidence key={e.id} projectId={projectId} id={id} evidenceId={e.id} />
            )}
          </div>
        ))}
      </section>
      {i.recordings?.map((r) => (
        <section className="connected-panel section" key={r.id}>
          <h3>Interaction recording</h3>
          <p>
            {r.eligible
              ? "Eligible JSON responses can be reused without live provider calls on the isolated executor."
              : "This recording is incomplete or outside replay support."}
          </p>
          {r.eligible && (
            <button className="btn" disabled={replay.isPending} onClick={() => replay.mutate(r.id)}>
              Replay recorded test
            </button>
          )}
          <ErrorMessage error={replay.error} />
        </section>
      ))}
      {failed && !busy(i) && (
        <form
          className="connected-panel form-stack section"
          onSubmit={(e) => {
            e.preventDefault();
            verify.mutate();
          }}
        >
          <h2>Verify a repair</h2>
          <p>
            Your coding agent can supply the candidate automatically through MCP. To verify here,
            select its immutable commit.
          </p>
          <label>
            Candidate commit
            <input
              required
              pattern="[a-f0-9]{40}"
              maxLength={40}
              value={commit}
              onChange={(e) => setCommit(e.target.value)}
              placeholder="40-character Git commit SHA"
            />
          </label>
          <button className="btn primary" disabled={verify.isPending}>
            Verify candidate
          </button>
          <ErrorMessage error={verify.error} />
        </form>
      )}
      {!busy(i) && i.status !== "CANCELLED" && (
        <details className="disclosure section">
          <summary>Run an existing test</summary>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              execute.mutate();
            }}
          >
            <ExistingTest projectId={projectId} value={testPath} onChange={setTestPath} />
            <p className="hint">
              Uses the connected executor and its execution allowance. Each investigation has a
              three-attempt limit.
            </p>
            <button className="btn" disabled={execute.isPending || (i.attempts?.length ?? 0) >= 3}>
              Run focused test
            </button>
            <ErrorMessage error={execute.error} />
          </form>
        </details>
      )}
      {!!i.attempts?.length && (
        <details className="disclosure section">
          <summary>Execution history ({i.attempts.length})</summary>
          {i.attempts.map((a) => (
            <div className="stat-row" key={a.id}>
              <span>
                {a.status.toLowerCase()} · {a.id}
              </span>
              {a.checkId && (
                <Link
                  className="text-link"
                  to={`/projects/${projectId}/checks/${encodeURIComponent(a.checkId)}`}
                >
                  Repository check
                </Link>
              )}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
interface Grant {
  id: string;
  name: string;
  scopes_json: string;
  created_at: string;
  revoked_at: string | null;
}
export function ConnectionsPage() {
  const { projectId, projects } = useWorkspace(),
    cache = useQueryClient();
  const [connect, setConnect] = useState(false),
    [setup, setSetup] = useState(false),
    [client, setClient] = useState<"chatgpt" | "antigravity" | "other">("chatgpt"),
    [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(""),
    [revokeTarget, setRevokeTarget] = useState<Grant | null>(null);
  const project = projects.find((p) => p.id === projectId),
    endpoint = window.location.origin + "/mcp";
  const antigravitySetup = `Add a remote MCP server named traceyard to my Antigravity global MCP configuration. Use serverUrl ${endpoint}. Preserve every existing server and setting. The configuration is at ~/.gemini/config/mcp_config.json (under USERPROFILE on Windows). Save the configuration, then tell me how to reload the server and click Authenticate in Customizations > Installed > MCP Servers. During Traceyard consent I should choose ${project?.repository ?? project?.name ?? "my project"}. Let me complete browser consent and any authorization-code entry myself.`;
  const copy = (value: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setCopyError("");
      })
      .catch(() =>
        setCopyError("Clipboard access is unavailable. Select and copy the text below."),
      );
  };
  const catalog = useQuery({
    queryKey: ["catalog", projectId],
    queryFn: () => integrationRequest<Catalog>(projectId, "catalog"),
    enabled: !!project?.repository,
    refetchOnWindowFocus: true,
  });
  const grants = useQuery({
    queryKey: ["agent-connections", projectId],
    queryFn: () => integrationRequest<{ items: Grant[] }>(projectId, "agent-connections"),
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.items.some((g) => !g.revoked_at) ? false : 15000),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      integrationRequest(
        projectId,
        `agent-connections/${encodeURIComponent(id)}/revoke`,
        "POST",
        {},
      ),
    onSuccess: () => {
      setRevokeTarget(null);
      void cache.invalidateQueries({ queryKey: ["agent-connections", projectId] });
    },
  });
  const ready =
    catalog.data?.executionAvailable &&
    (catalog.data.executionProvider === "managed" || catalog.data.repository?.runner_enabled !== 0);
  const authorized = grants.data?.items.filter((g) => !g.revoked_at) ?? [];
  return (
    <div className="connections-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">{project?.repository ?? project?.name}</p>
          <h1>Project setup</h1>
          <p>
            Connect your repository and enable tests. Add your coding agent whenever you’re ready.
          </p>
        </div>
        <Link className="btn primary" to="/investigations">
          Open investigations <Icon name="arrow-right" />
        </Link>
      </div>
      <ol className="connection-checklist" aria-label="Project readiness">
        <li>
          <Icon name={project?.repository ? "circle-check" : "circle"} />
          <span>
            <strong>Repository</strong>
            <small>{project?.repository ? "Connected" : "Choose a repository"}</small>
          </span>
        </li>
        <li>
          <Icon name={ready ? "circle-check" : "circle"} />
          <span>
            <strong>Test execution</strong>
            <small>
              {catalog.isPending && project?.repository
                ? "Checking…"
                : ready
                  ? "Enabled"
                  : "Setup needed"}
            </small>
          </span>
        </li>
        <li>
          <Icon name={authorized.length ? "circle-check" : "circle"} />
          <span>
            <strong>Coding agent</strong>
            <small>
              {authorized.length
                ? `${authorized.length} authorized`
                : "Optional · use the app directly"}
            </small>
          </span>
        </li>
      </ol>
      <div className="connection-layout">
        <div className="connection-foundations">
          <section className="connected-panel">
            <div className="section-head">
              <h2>Repository</h2>
              <State value={project?.repository ? "CONNECTED" : "NOT_CONNECTED"} />
            </div>
            <p>{project?.repository ?? "Choose a repository from your GitHub account."}</p>
            {project?.repository ? (
              <Link className="btn" to={"/projects/" + projectId}>
                Repository details
              </Link>
            ) : (
              <button className="btn primary" onClick={() => setConnect(true)}>
                Connect repository
              </button>
            )}
          </section>
          <section className="connected-panel section">
            <div className="section-head">
              <h2>Test execution</h2>
              {ready && <State value="ENABLED" />}
            </div>
            {catalog.isPending && project?.repository ? (
              <p role="status">Checking execution connection…</p>
            ) : (
              <p>
                {ready
                  ? `${catalog.data?.executionProvider === "managed" ? "Managed" : "GitHub Actions"} execution is enabled for this repository.`
                  : project?.repository
                    ? "Enable the reviewed execution workflow to run repository tests."
                    : "Connect a repository before configuring test execution."}
              </p>
            )}
            {project?.repository && catalog.data?.executionProvider !== "managed" && (
              <button className={ready ? "btn" : "btn primary"} onClick={() => setSetup(true)}>
                {ready ? "Review execution setup" : "Set up test execution"}
              </button>
            )}
            <p className="hint">
              GitHub execution uses your Actions allowance. You can inspect indexed source without
              enabling it.
            </p>
            <ErrorMessage error={catalog.error} />
            {catalog.isError && (
              <button className="btn" onClick={() => void catalog.refetch()}>
                Check again
              </button>
            )}
          </section>
        </div>
        <section className="connected-panel agent-setup">
          <div className="section-head">
            <h2>Use your coding agent</h2>
            {authorized.length > 0 && <State value="AUTHORIZED" />}
          </div>
          <p>
            Authorize access to this project. Your agent and this app share the same investigations
            and results.
          </p>
          <div className="segmented client-picker" role="group" aria-label="Coding agent">
            {(
              [
                ["chatgpt", "ChatGPT Work"],
                ["antigravity", "Antigravity"],
                ["other", "Other client"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={client === value}
                className={client === value ? "selected" : ""}
                onClick={() => {
                  setClient(value);
                  setCopied(false);
                  setCopyError("");
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mcp-endpoint">
            <code>{endpoint}</code>
            <button className="btn" onClick={() => copy(endpoint)}>
              {copied ? "Copied" : "Copy MCP URL"}
            </button>
          </div>
          {client === "chatgpt" ? (
            <ol className="setup-instructions">
              <li>
                In ChatGPT, open <strong>Plugins → + → Add custom MCP server</strong>.
              </li>
              <li>
                Name it <strong>Traceyard</strong>, paste the MCP URL and choose{" "}
                <strong>OAuth</strong>. Create and install the plugin.
              </li>
              <li>
                Complete browser authorization and choose{" "}
                <strong>{project?.repository ?? project?.name}</strong>. In Work, select{" "}
                <strong>@Traceyard</strong> and ask it to inspect the connected project.
              </li>
            </ol>
          ) : client === "antigravity" ? (
            <div>
              <p>Ask Antigravity to add the server without changing your existing connections.</p>
              <button className="btn" onClick={() => copy(antigravitySetup)}>
                {copied ? "Copied" : "Copy Antigravity setup request"}
              </button>
              <ol className="setup-instructions">
                <li>Paste the setup request into Antigravity.</li>
                <li>
                  Open <strong>Customizations → Installed → MCP Servers</strong> and choose{" "}
                  <strong>Authenticate</strong> for Traceyard.
                </li>
                <li>
                  Complete browser authorization for{" "}
                  <strong>{project?.repository ?? project?.name}</strong>. If asked, paste the
                  callback code into Antigravity.
                </li>
              </ol>
              <details className="disclosure">
                <summary>View setup request</summary>
                <p className="setup-request">{antigravitySetup}</p>
              </details>
            </div>
          ) : (
            <ol className="setup-instructions">
              <li>Add a remote HTTP MCP server using the URL above.</li>
              <li>
                Choose OAuth and complete browser authorization for{" "}
                <strong>{project?.repository ?? project?.name}</strong>.
              </li>
              <li>
                Ask your agent to use Traceyard’s <code>inspect</code> tool with{" "}
                <code>section: capabilities</code> before its first investigation.
              </li>
            </ol>
          )}
          {copyError && <p role="status">{copyError}</p>}
          <p className="hint">
            No API key is needed. Your client must support remote HTTP MCP with OAuth.
          </p>
        </section>
      </div>
      <section className="connected-panel section">
        <div className="section-head">
          <h2>Authorized agents</h2>
          <button
            className="btn"
            disabled={grants.isFetching}
            onClick={() => void grants.refetch()}
          >
            <Icon name="arrows-rotate" />
            {grants.isFetching ? "Checking…" : "Refresh status"}
          </button>
        </div>
        <p className="hint">
          Access is limited to this project. An authorization remains listed when its client is
          closed.
        </p>
        {grants.isPending ? (
          <p role="status">Loading agents…</p>
        ) : grants.isError ? (
          <ErrorMessage error={grants.error} />
        ) : grants.data.items.length ? (
          grants.data.items.map((g) => (
            <article className="stat-row" key={g.id}>
              <div>
                <strong>{g.name}</strong>
                <p className="hint">
                  {(JSON.parse(g.scopes_json) as string[])
                    .map(
                      (scope) =>
                        ({
                          "investigations:read": "Read evidence",
                          "investigations:run": "Run tests",
                          "runs:recover": "Recover workflows",
                        })[scope] ?? scope,
                    )
                    .join(" · ")}
                </p>
              </div>
              {g.revoked_at ? (
                <span className="hint">Revoked</span>
              ) : (
                <button
                  className="btn"
                  onClick={() => {
                    revoke.reset();
                    setRevokeTarget(g);
                  }}
                >
                  Revoke access
                </button>
              )}
            </article>
          ))
        ) : (
          <p>No agents authorized yet. Complete the connection above, then refresh this status.</p>
        )}
      </section>
      <details className="disclosure section">
        <summary>Runtime tracing and advanced connections</summary>
        <p>
          Connect a running application to inspect its runtime traces. Repository tests and MCP do
          not require runtime instrumentation.
        </p>
        <Link className="btn" to="/connect">
          Set up runtime tracing
        </Link>
      </details>
      {connect && (
        <ConnectRepository
          destination="investigate"
          mode="github"
          close={() => setConnect(false)}
          connected={() => {
            setConnect(false);
            void cache.invalidateQueries({ queryKey: ["projects"] });
          }}
        />
      )}
      {setup && (
        <EnableGitHubChecks
          enableOnly
          projectId={projectId}
          close={() => setSetup(false)}
          onReady={() => {
            setSetup(false);
            void catalog.refetch();
          }}
        />
      )}
      {revokeTarget && (
        <Modal title="Revoke agent access?" close={() => setRevokeTarget(null)}>
          <p>
            {revokeTarget.name} will lose access to this project. You can authorize it again later.
          </p>
          <ErrorMessage error={revoke.error} />
          <div className="dialog-actions">
            <button className="btn" onClick={() => setRevokeTarget(null)}>
              Keep access
            </button>
            <button
              className="btn primary"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(revokeTarget.id)}
            >
              {revoke.isPending ? "Revoking…" : "Revoke access"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
