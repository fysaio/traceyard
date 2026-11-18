import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ProjectLink as Link } from "../components/project-link";
import { ErrorMessage, Icon } from "../components/product-ui";
import { useWorkspace } from "../lib/workspace";
import { investigations } from "../lib/investigations-api";
import { integrationRequest } from "../lib/integrations-api";
import { newIdempotencyKey } from "../lib/api";
import { ConnectRepository } from "./project-overview";
import { EnableGitHubChecks } from "./project-experience";
import type { Investigation } from "../../shared/contracts/investigations";
import type { Catalog } from "../../shared/repository/workspace";

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
  return (
    <span className={"status " + value.toLowerCase()}>
      {value.toLowerCase().replaceAll("_", " ")}
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
    [connect, setConnect] = useState(false),
    [key, setKey] = useState(newIdempotencyKey);
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
        captureInteractions: capture,
        testPath: testPath || undefined,
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
          <p>Run a focused check. Keep the evidence. Verify the repair.</p>
        </div>
        <Link to="/connections" className="btn">
          <Icon name="plug" /> Connections
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
            <button className="btn primary" disabled={create.isPending}>
              {create.isPending ? "Starting…" : "Investigate"}
              <Icon name="arrow-right" />
            </button>
          </div>
          <p className="hint">
            {mode === "execute"
              ? "Runs an existing test using your connected executor. GitHub execution uses your Actions allowance."
              : "Reads retained code and runtime evidence without running your application."}
          </p>
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
  const verificationId = params.get("verification") ?? "";
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
        <State value={i.status} />
      </div>
      <section className="connected-panel finding-panel" aria-labelledby="finding-title">
        <p className="eyebrow">
          {i.finding.basis === "observed" ? "Recorded finding" : "Source analysis"}
        </p>
        <h2 id="finding-title">{busy(i) ? "The focused check is running" : "What we found"}</h2>
        <p className="finding-summary">{i.finding.summary}</p>
        {i.finding.nextAction && <p>{i.finding.nextAction}</p>}
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
        <span>{i.snapshot.filesScanned} indexed files</span>
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
              <Link className="btn" to={"/investigations/" + verification.data.candidateId}>
                Open candidate evidence
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
    cache = useQueryClient(),
    [connect, setConnect] = useState(false),
    [setup, setSetup] = useState(false),
    [copied, setCopied] = useState<"endpoint" | "antigravity" | null>(null),
    [copyError, setCopyError] = useState("");
  const project = projects.find((p) => p.id === projectId),
    endpoint = window.location.origin + "/mcp";
  const antigravitySetup = `Add a remote MCP server named traceyard to my Antigravity global MCP configuration. Use serverUrl ${endpoint}. Preserve every existing server and setting. The configuration is at ~/.gemini/config/mcp_config.json (under USERPROFILE on Windows). Save the configuration, then tell me how to reload the server and click Authenticate in Customizations > Installed > MCP Servers. During Traceyard consent I should choose ${project?.repository ?? project?.name ?? "the project I want to debug"}. Let me complete browser consent and any authorization-code entry in Antigravity myself.`;
  const copy = (value: string, kind: "endpoint" | "antigravity") => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(kind);
        setCopyError("");
      })
      .catch(() => setCopyError("Clipboard access is unavailable. Use the text shown below."));
  };
  const catalog = useQuery({
    queryKey: ["catalog", projectId],
    queryFn: () => integrationRequest<Catalog>(projectId, "catalog"),
    enabled: !!project?.repository,
  });
  const grants = useQuery({
    queryKey: ["agent-connections", projectId],
    queryFn: () => integrationRequest<{ items: Grant[] }>(projectId, "agent-connections"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      integrationRequest(
        projectId,
        `agent-connections/${encodeURIComponent(id)}/revoke`,
        "POST",
        {},
      ),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["agent-connections", projectId] }),
  });
  return (
    <div className="connections-page">
      <div className="page-head">
        <div>
          <h1>Connections</h1>
          <p>Connect the repository once. Investigate from your coding agent or this app.</p>
        </div>
        <Link className="btn" to="/investigations">
          Investigate a problem
        </Link>
      </div>
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
        <h2>Test execution</h2>
        {catalog.isPending && project?.repository ? (
          <p role="status">Checking execution connection…</p>
        ) : (
          <>
            <p>
              {catalog.data?.executionAvailable
                ? catalog.data.executionProvider === "managed" ||
                  !!catalog.data.repository?.runner_enabled
                  ? `${catalog.data.executionProvider === "managed" ? "Managed" : "GitHub"} execution is enabled. Availability is checked when a test launches.`
                  : "GitHub execution is available. Review the repository workflow to enable tests."
                : "Source analysis is available after repository scanning. Running tests also needs an executor."}
            </p>
            {project?.repository && catalog.data?.executionProvider !== "managed" && (
              <button className="btn" onClick={() => setSetup(true)}>
                Review GitHub execution setup
              </button>
            )}
          </>
        )}
        <p className="hint">
          GitHub execution requires a reviewed workflow file and uses your Actions allowance.
          Production runtime tracing is optional for source and test investigations.
        </p>
        <ErrorMessage error={catalog.error} />
      </section>
      <section className="connected-panel section">
        <h2>Use your coding agent</h2>
        <p>
          Connect once, then ask your coding agent to investigate with Traceyard. It can read
          findings and run focused checks for the project you approve.
        </p>
        <details className="disclosure">
          <summary>Connect with Antigravity</summary>
          <p>Ask Antigravity to add the connection while keeping your existing servers.</p>
          <button className="btn" onClick={() => copy(antigravitySetup, "antigravity")}>
            {copied === "antigravity" ? "Setup request copied" : "Copy Antigravity setup request"}
          </button>
          <ol>
            <li>Paste the request into an Antigravity chat and review its configuration update.</li>
            <li>In Customizations → Installed → MCP Servers, choose Authenticate for Traceyard.</li>
            <li>
              Choose this Traceyard project in the browser and connect. If Antigravity asks for a
              code, paste the callback page’s code into Antigravity to finish.
            </li>
          </ol>
          <p className="hint">An Unauthorized status means authentication has not finished yet.</p>
          <details>
            <summary>View setup request</summary>
            <p>{antigravitySetup}</p>
          </details>
        </details>
        <div className="mcp-endpoint">
          <code>{endpoint}</code>
          <button className="btn" onClick={() => copy(endpoint, "endpoint")}>
            {copied === "endpoint" ? "Copied" : "Copy MCP URL"}
          </button>
        </div>
        {copyError && <p role="status">{copyError}</p>}
        <p className="hint">
          No API key to paste. Your coding agent must support remote HTTP MCP with OAuth.
        </p>
        <details className="disclosure">
          <summary>Example agent request</summary>
          <p>
            “Use Traceyard to investigate why the checkout retry test fails. Inspect the finding,
            repair the relevant code, then verify the candidate commit.”
          </p>
        </details>
      </section>
      <section className="section">
        <h2>Authorized agents</h2>
        {grants.isPending ? (
          <p role="status">Loading agents…</p>
        ) : grants.isError ? (
          <ErrorMessage error={grants.error} />
        ) : grants.data.items.length ? (
          grants.data.items.map((g) => (
            <article className="stat-row" key={g.id}>
              <div>
                <strong>{g.name}</strong>
                <p className="hint">{JSON.parse(g.scopes_json).join(", ")}</p>
              </div>
              {g.revoked_at ? (
                <span className="hint">Revoked</span>
              ) : (
                <button
                  className="btn"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(g.id)}
                >
                  Revoke access
                </button>
              )}
            </article>
          ))
        ) : (
          <p className="hint">Agents appear here after you authorize a connection.</p>
        )}
        <ErrorMessage error={revoke.error} />
      </section>
      <details className="disclosure section">
        <summary>Production tracing and advanced connections</summary>
        <p>
          Attach a deployed application when you need production traces. These are separate from
          repository access and test execution.
        </p>
        <Link className="btn" to="/connect">
          Connect runtime tracing
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
    </div>
  );
}
