import {
  ProjectsPage,
  ProjectPage,
  OperationPage,
  ApplicationRunPage,
  ProjectCheckPage,
  RunComparePage,
} from "./pages/project-experience";
import { RepositorySetup } from "./pages/project-overview";
import { ProjectLink as Link } from "./components/project-link";
import { WorkflowDetail } from "./pages/workflow-detail";
import { WorkspaceShell } from "./pages/workspace-shell";
import { WorkflowLibrary, TemplateDetail } from "./pages/workflow-library";
import { SettingsLayout, ConnectApplication } from "./pages/project-settings";
import {
  Gateway,
  Approvals,
  Traces,
  Developer,
  Automations,
  Experiments,
} from "./pages/integrations";
import { Compare } from "./pages/compare";
import { Studio } from "./pages/studio";
import { RunLedger } from "./pages/run-ledger";
import { useState, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, readAllEvents, newIdempotencyKey, type AuthSession } from "./lib/api";
import type { WorkflowSummary } from "../shared/contracts/api";
import { documentInputSchema, type FailureScenario } from "../shared/workflow/document";

const Icon = ({ name }: { name: string }) => (
  <i className={`fa-solid fa-${name}`} aria-hidden="true" />
);
const message = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed. Try again.";
const label = (value: string) => value.toLowerCase().replaceAll("_", " ");
const terminal = (status: string) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status);
const duration = (value: number | null) =>
  value === null ? "—" : value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(2)}s`;
function Notice({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="request-error" role="alert">
      <p>{message(error)}</p>
      {retry && (
        <button className="btn" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
function Loading() {
  return (
    <div className="loading-state" role="status">
      <Icon name="circle-notch" /> Loading your workspace…
    </div>
  );
}
function Heading({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      <div className="actions">{actions}</div>
    </div>
  );
}
function Status({ value }: { value: string }) {
  return (
    <span className={`status ${value.toLowerCase()}`}>
      <Icon
        name={
          value === "SUCCEEDED"
            ? "circle-check"
            : value === "FAILED"
              ? "circle-xmark"
              : value === "RUNNING"
                ? "circle-notch"
                : "circle"
        }
      />
      {label(value)}
    </span>
  );
}
function Json({ value }: { value: unknown }) {
  return <pre className="code">{JSON.stringify(value, null, 2) ?? "No value recorded."}</pre>;
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export function App() {
  const session = useQuery({
    queryKey: ["auth"],
    queryFn: api.authSession,
    retry: false,
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });
  if (session.isPending)
    return (
      <main className="product-main">
        <Loading />
      </main>
    );
  if (session.isError)
    return (
      <main className="product-main">
        <Heading title="Cannot reach Traceyard" />
        <Notice error={session.error} retry={() => void session.refetch()} />
      </main>
    );
  if (!session.data.user) return <Welcome session={session.data} />;
  return <Workspace session={session.data} />;
}
function Welcome({ session }: { session: AuthSession }) {
  return (
    <div className="entry">
      <Link to="/" className="brand">
        Traceyard.
      </Link>
      <main>
        <div className="entry-mark">
          <Icon name="diagram-project" />
        </div>
        <h1>Execute workflows. Recover when they break.</h1>
        <p>
          An open-source platform for executing, observing, debugging and recovering workflows and
          AI agents.
        </p>
        <div className="entry-actions">
          {session.githubSignInAvailable ? (
            <a className="btn primary" href="/api/auth/github/start">
              <i className="fa-brands fa-github" aria-hidden="true" /> Continue with GitHub
            </a>
          ) : (
            <>
              <button className="btn primary" disabled>
                <i className="fa-brands fa-github" aria-hidden="true" /> GitHub sign-in unavailable
              </button>
              <p className="hint">
                The server needs its GitHub OAuth configuration before you can sign in.
              </p>
            </>
          )}
        </div>
        <span className="entry-foot">Open source. Self-hostable.</span>
      </main>
    </div>
  );
}
function Workspace({ session }: { session: AuthSession }) {
  return (
    <WorkspaceShell session={session}>
      {(projectId) => (
        <Routes>
          <Route
            path="/"
            element={
              <Navigate
                to={"/workflows" + (projectId ? "?project=" + encodeURIComponent(projectId) : "")}
                replace
              />
            }
          />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:selectedProject" element={<ProjectPage key={projectId} />} />
          <Route
            path="/projects/:selectedProject/operations/:operationKey"
            element={<OperationPage key={projectId} />}
          />
          <Route
            path="/projects/:selectedProject/runs/:traceId"
            element={<ApplicationRunPage key={projectId} />}
          />
          <Route
            path="/projects/:selectedProject/checks/:checkId"
            element={<ProjectCheckPage key={projectId} />}
          />
          <Route
            path="/projects/:selectedProject/compare"
            element={<RunComparePage key={projectId} />}
          />
          <Route path="/repository-setup" element={<RepositorySetup />} />
          <Route
            path="/builder"
            element={<WorkflowLibrary key={projectId} projectId={projectId} />}
          />
          <Route
            path="/workflows"
            element={<WorkflowLibrary key={projectId} projectId={projectId} />}
          />
          <Route path="/workflow/:id" element={<WorkflowDetail projectId={projectId} />} />
          <Route path="/executions" element={<RunLedger key={projectId} projectId={projectId} />} />
          <Route path="/executions/:id" element={<Execution />} />
          <Route path="/analytics" element={<Navigate to={"/projects/" + projectId} replace />} />
          <Route
            path="/laboratory"
            element={<Experiments key={projectId} projectId={projectId} />}
          />
          <Route path="/studio/:id" element={<Studio projectId={projectId} />} />
          <Route path="/gateway" element={<Gateway key={projectId} projectId={projectId} />} />
          <Route path="/traces" element={<Traces key={projectId} projectId={projectId} />} />
          <Route path="/approvals" element={<Approvals key={projectId} projectId={projectId} />} />
          <Route path="/developer" element={<Developer key={projectId} projectId={projectId} />} />
          <Route
            path="/automations"
            element={<Automations key={projectId} projectId={projectId} />}
          />
          <Route path="/compare" element={<Compare projectId={projectId} />} />
          <Route
            path="/template/:id"
            element={<TemplateDetail key={projectId} projectId={projectId} />}
          />
          <Route path="/connect" element={<ConnectApplication key={projectId} />} />
          <Route path="/settings" element={<Navigate to="/settings/projects" replace />} />
          <Route
            path="/settings/:section"
            element={<SettingsLayout account={<Settings session={session} />} />}
          />
          <Route
            path="*"
            element={
              <Empty title="Page not found">
                <Link to="/">Return to workflows</Link>
              </Empty>
            }
          />
        </Routes>
      )}
    </WorkspaceShell>
  );
}
export function Launch({
  workflow,
  projectId,
  close,
  initialInput,
  parentRunId,
  fault = "success",
}: {
  workflow: WorkflowSummary;
  projectId?: string;
  close: () => void;
  initialInput?: unknown;
  parentRunId?: string;
  fault?: FailureScenario;
}) {
  const navigate = useNavigate(),
    cache = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = window.document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      trigger?.focus();
    };
  }, []);
  const [graphInput, setGraphInput] = useState(
    JSON.stringify(
      initialInput ?? workflow.graph?.nodes.find((n) => n.type === "input")?.config.value ?? {},
      null,
      2,
    ),
  );
  const inputValue = () =>
    workflow.graph ? (JSON.parse(graphInput) as unknown) : { title, document };
  const initial = documentInputSchema.safeParse(initialInput);
  const [title, setTitle] = useState(initial.success ? initial.data.title : ""),
    [document, setDocument] = useState(initial.success ? initial.data.document : "");
  const [error, setError] = useState(""),
    [configName, setConfigName] = useState("");
  const [idempotencyKey, setKey] = useState(newIdempotencyKey);
  const mutation = useMutation({
    mutationFn: () =>
      api.launch(
        {
          workflowId: workflow.id,
          ...(projectId ? { projectId } : {}),
          ...(parentRunId ? { parentRunId } : {}),
          version: workflow.version,
          input: inputValue(),
          scenario: fault,
        },
        idempotencyKey,
      ),
    onSuccess: (result) => {
      void cache.invalidateQueries({ queryKey: ["runs"] });
      navigate(`/executions/${result.result.run.id}${projectId ? "?project=" + projectId : ""}`);
      close();
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api.createSavedWorkflow(projectId!, {
        name: configName,
        description: workflow.description,
        definition: {
          runtimeWorkflowId: workflow.id,
          runtimeVersion: workflow.version,
          version: workflow.version,
          input: inputValue(),
        },
      }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["saved", projectId] });
      setConfigName("");
      setError("Configuration saved to your project.");
    },
  });
  const validate = () => {
    if (workflow.graph) {
      try {
        JSON.parse(graphInput);
        setError("");
        return true;
      } catch {
        setError("Enter valid JSON input.");
        return false;
      }
    }
    const parsed = documentInputSchema.safeParse({ title, document });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join(" "));
      return false;
    }
    setError("");
    return true;
  };
  function submit(e: FormEvent) {
    e.preventDefault();
    if (validate()) mutation.mutate();
  }
  return (
    <dialog
      ref={dialogRef}
      className="launch-surface"
      aria-labelledby="launch-title"
      onCancel={close}
    >
      <div className="modal-head">
        <h2 id="launch-title">Run {workflow.name}</h2>
        <button
          type="button"
          className="btn icon-only"
          aria-label="Close launch dialog"
          onClick={close}
        >
          <Icon name="xmark" />
        </button>
      </div>
      <form onSubmit={submit}>
        {parentRunId && (
          <p className="hint">
            This starts a linked execution with edited input. All steps execute again; completed
            external actions may repeat.
          </p>
        )}
        {workflow.graph ? (
          <div className="field">
            <label htmlFor="graph-input">JSON input</label>
            <textarea
              id="graph-input"
              rows={10}
              value={graphInput}
              onChange={(e) => {
                setGraphInput(e.target.value);
                setKey(newIdempotencyKey());
              }}
            />
          </div>
        ) : (
          <>
            {" "}
            <div className="field">
              <label htmlFor="document-title">Document title</label>
              <input
                autoFocus
                id="document-title"
                required
                minLength={3}
                maxLength={120}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setKey(newIdempotencyKey());
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="document-body">Document</label>
              <textarea
                id="document-body"
                rows={7}
                required
                minLength={24}
                maxLength={10000}
                value={document}
                onChange={(e) => {
                  setDocument(e.target.value);
                  setKey(newIdempotencyKey());
                }}
              />
            </div>
          </>
        )}
        {fault !== "success" && (
          <p className="hint">Controlled failure scenario: {label(fault)}.</p>
        )}
        {projectId && (
          <details className="disclosure">
            <summary>Save this input for later</summary>
            <label htmlFor="configuration-name">Configuration name</label>
            <input
              id="configuration-name"
              value={configName}
              onChange={(e) => setConfigName(e.target.value)}
              maxLength={120}
            />
            <button
              type="button"
              className="btn"
              disabled={save.isPending || !configName.trim()}
              onClick={() => {
                if (validate()) save.mutate();
              }}
            >
              Save configuration
            </button>
          </details>
        )}
        {error && <p role="status">{error}</p>}
        {mutation.isError && <Notice error={mutation.error} />}
        {save.isError && <Notice error={save.error} />}
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Submitting…" : "Start execution"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function Execution() {
  const { id = "" } = useParams(),
    navigate = useNavigate(),
    cache = useQueryClient();
  const run = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.run(id),
    refetchInterval: (q) => (q.state.data && terminal(q.state.data.status) ? false : 1500),
  });
  const [tab, setTab] = useState("summary"),
    [editWorkflow, setEditWorkflow] = useState<WorkflowSummary | null>(null),
    [step, setStep] = useState<string | null>(null),
    [walk, setWalk] = useState(false);
  const prepareEdit = useMutation({
    mutationFn: () => {
      const current = run.data;
      if (!current) throw Error("Load the execution first.");
      return api.workflow(current.workflow.id, current.projectId, current.workflow.version);
    },
    onSuccess: setEditWorkflow,
  });
  const events = useQuery({
    queryKey: ["events", id],
    queryFn: () => readAllEvents(id),
    enabled: tab === "events",
    refetchInterval: tab === "events" && !terminal(run.data?.status ?? "QUEUED") ? 2500 : false,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancel(id),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["run", id] });
      void cache.invalidateQueries({ queryKey: ["runs"] });
    },
  });
  const retry = useMutation({
    mutationFn: (mode: "restart" | "resume") => api.retry(id, mode),
    onSuccess: (result) => {
      setStep(null);
      setTab("summary");
      void cache.invalidateQueries({ queryKey: ["runs"] });
      navigate(`/executions/${result.run.id}${window.location.search}`);
    },
    onError: () => {
      void cache.invalidateQueries({ queryKey: ["run", id] });
    },
  });
  const exportTrace = useMutation({ mutationFn: () => readAllEvents(id) });
  if (run.isPending) return <Loading />;
  if (run.isError) return <Notice error={run.error} retry={() => void run.refetch()} />;
  const r = run.data,
    index = r.steps.findIndex((s) => s.id === step),
    selected = r.steps[index];
  const download = async () => {
    const allEvents = await exportTrace.mutateAsync().catch(() => null);
    if (!allEvents) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ ...r, events: allEvents.items }, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <Link className="back" to="/executions">
        ← Executions
      </Link>
      <Heading
        title={r.workflow.name}
        actions={
          <>
            {!terminal(r.status) && (
              <button
                className="btn"
                disabled={cancel.isPending || r.status === "CANCELLING"}
                onClick={() => cancel.mutate()}
              >
                Cancel execution
              </button>
            )}
            {r.status === "FAILED" && !r.retryRunId && (
              <>
                <button
                  className="btn primary"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate("resume")}
                >
                  Resume failed work
                </button>
                <button
                  className="btn"
                  disabled={retry.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Restart every step? Completed HTTP calls and model requests may run again. Resume reuses completed steps instead.",
                      )
                    )
                      retry.mutate("restart");
                  }}
                >
                  Restart from beginning
                </button>
              </>
            )}
            {r.retryRunId && (
              <Link className="btn primary" to={"/executions/" + r.retryRunId}>
                Open recovery execution
              </Link>
            )}
            {terminal(r.status) && (
              <button
                className="btn"
                disabled={prepareEdit.isPending}
                onClick={() => prepareEdit.mutate()}
              >
                Edit input and run
              </button>
            )}
            <button
              className="btn"
              onClick={() => void download()}
              disabled={exportTrace.isPending}
            >
              {exportTrace.isPending ? "Exporting…" : "Export trace"}
            </button>
          </>
        }
      />
      <div className="quiet-meta">
        <Status value={r.status} />
        <span>Version {r.workflow.version}</span>
        <span>{duration(r.durationMs)}</span>
        <span>{r.id}</span>
        <Link className="text-link" to="/approvals">
          Review approvals
        </Link>
        <Link className="text-link" to={"/compare?left=" + r.id}>
          Compare
        </Link>
      </div>
      {r.parentRunId && (
        <Link to={`/executions/${r.parentRunId}`} className="text-link">
          Original execution
        </Link>
      )}
      {r.recoveryMode === "resume" && (
        <p className="hint">
          Resumed with {r.steps.filter((s) => s.reusedFromRunId).length} completed steps reused. The
          original input and workflow version are retained.
        </p>
      )}
      {r.error && <Notice error={new Error(r.error.message)} />}
      {r.error?.stepKey && (
        <section className="connected-panel section">
          <h2>
            Failed at {r.steps.find((s) => s.key === r.error?.stepKey)?.name ?? r.error.stepKey}
          </h2>
          <p className="hint">
            {r.error.code} · {label(r.error.class)}
            {r.error.attempt ? ` · attempt ${r.error.attempt}` : ""}
          </p>
          <button
            className="btn"
            onClick={() => {
              setTab("trace");
              setStep(r.steps.find((s) => s.key === r.error?.stepKey)?.id ?? null);
            }}
          >
            Inspect failed step
          </button>
        </section>
      )}
      {r.status === "FAILED" && (
        <p className="hint">
          Resume reuses completed outputs and retries unfinished steps. An external service must
          honor idempotency keys to prevent duplicate effects after an uncertain request.
        </p>
      )}
      {cancel.isError && <Notice error={cancel.error} />}
      {retry.isError && <Notice error={retry.error} />}
      {prepareEdit.isError && <Notice error={prepareEdit.error} />}
      {editWorkflow && (
        <Launch
          workflow={editWorkflow}
          projectId={r.projectId}
          parentRunId={r.id}
          initialInput={r.input}
          close={() => setEditWorkflow(null)}
        />
      )}
      {exportTrace.isError && <Notice error={exportTrace.error} />}
      <div className="product-tabs" role="tablist">
        {["summary", "trace", "events"].map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "summary" ? (
        <section className="connected-panel result-output">
          <h2>
            {r.status === "SUCCEEDED"
              ? "Output is ready"
              : terminal(r.status)
                ? "Execution stopped"
                : "Execution in progress"}
          </h2>
          <p>
            {r.stepCounts.succeeded} of {r.stepCounts.total} steps complete.
          </p>
          {!terminal(r.status) && (
            <p role="status">
              {r.steps.find((s) => s.status === "RUNNING")?.name ??
                `Dispatch ${label(r.dispatch.status)}`}
            </p>
          )}
          {r.output !== null && <Json value={r.output} />}
          <details className="disclosure">
            <summary>Submitted input</summary>
            <Json value={r.input} />
          </details>
          <button className="btn" onClick={() => setTab("trace")}>
            Inspect trace
          </button>
        </section>
      ) : tab === "events" ? (
        events.isPending ? (
          <Loading />
        ) : events.isError ? (
          <Notice error={events.error} />
        ) : (
          <div className="event-list">
            {events.data.items.map((e) => (
              <article className="connected-panel" key={e.id}>
                <span className="hint">
                  {new Date(e.createdAt).toLocaleString()} · {e.type}
                </span>
                <h3>{e.message}</h3>
                <details>
                  <summary>Event details</summary>
                  <Json value={e.data} />
                </details>
              </article>
            ))}
            {events.data.nextCursor !== null && (
              <p className="hint">
                Showing the first page of events. Export trace for the full recorded run.
              </p>
            )}
          </div>
        )
      ) : (
        <>
          <div className="actions">
            <button
              className="btn"
              onClick={() => {
                setWalk(!walk);
                setStep(r.steps[0]?.id ?? null);
              }}
            >
              {walk ? "Finish walkthrough" : "Walk through steps"}
            </button>
          </div>
          {walk && selected && (
            <div className="step-walk">
              <h2>
                Step {index + 1}: {selected.name}
              </h2>
              <div className="step-walk-navigation">
                <button
                  className="btn"
                  disabled={index <= 0}
                  onClick={() => setStep(r.steps[index - 1]!.id)}
                >
                  Previous step
                </button>
                <button
                  className="btn primary"
                  disabled={index >= r.steps.length - 1}
                  onClick={() => setStep(r.steps[index + 1]!.id)}
                >
                  Next step
                </button>
              </div>
            </div>
          )}
          <div className={`trace-layout ${selected ? "inspecting" : ""}`}>
            <div className="timeline">
              {r.steps.map((s) => (
                <button
                  key={s.id}
                  className={`timeline-step ${s.id === step ? "selected" : ""}`}
                  onClick={() => setStep(s.id)}
                >
                  <span className="timeline-type">
                    <Icon name="cube" />
                  </span>
                  <div>
                    <strong>{s.name}</strong>
                    <span>
                      {s.reusedFromRunId
                        ? "Reused completed output"
                        : `${duration(s.durationMs)} · ${s.attemptCount} attempts`}
                    </span>
                  </div>
                  <Status value={s.status} />
                </button>
              ))}
            </div>
            {selected && (
              <aside className="step-inspector">
                <div className="inspector-title">
                  <h2>{selected.name}</h2>
                  <button
                    className="btn icon-only"
                    aria-label="Close step inspector"
                    onClick={() => setStep(null)}
                  >
                    <Icon name="xmark" />
                  </button>
                </div>
                <Status value={selected.status} />
                {selected.reusedFromRunId && (
                  <p>
                    Output reused from{" "}
                    <Link className="text-link" to={"/executions/" + selected.reusedFromRunId}>
                      the previous execution
                    </Link>
                    . This step did not execute again.
                  </p>
                )}
                {selected.error && <Notice error={new Error(selected.error.message)} />}
                <details className="disclosure" open>
                  <summary>Input</summary>
                  <Json value={selected.input} />
                </details>
                <details className="disclosure" open>
                  <summary>Output</summary>
                  <Json value={selected.output} />
                </details>
                {selected.attempts.length > 0 && (
                  <details className="disclosure">
                    <summary>Attempt history</summary>
                    {selected.attempts.map((a) => (
                      <div className="attempt-row" key={a.number}>
                        <strong>Attempt {a.number}</strong>
                        <Status value={a.status} />
                        <span>{duration(a.durationMs)}</span>
                        {a.error && <p>{a.error.message}</p>}
                        {a.input !== undefined && (
                          <Json value={{ input: a.input, output: a.output }} />
                        )}
                      </div>
                    ))}
                  </details>
                )}
              </aside>
            )}
          </div>
        </>
      )}
    </>
  );
}
function Settings({ session }: { session: AuthSession }) {
  const cache = useQueryClient();
  const revoke = useMutation({
    mutationFn: api.revokeSession,
    onSuccess: () => cache.invalidateQueries({ queryKey: ["auth"] }),
  });
  return (
    <>
      <Heading title="Settings" />
      <section className="connected-panel">
        <h2>{session.user?.name || session.user?.login}</h2>
        <p>Signed in with GitHub as {session.user?.login}.</p>
        <h3 className="section">Active sessions</h3>
        {session.sessions.map((s) => (
          <div className="stat-row" key={s.id}>
            <div>
              <strong>{s.current ? "This browser" : "Another browser"}</strong>
              <p>Last active {new Date(s.lastSeenAt).toLocaleString()}</p>
            </div>
            {!s.current && (
              <button
                className="btn"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(s.id)}
              >
                Revoke session
              </button>
            )}
          </div>
        ))}
        {revoke.isError && <Notice error={revoke.error} />}
      </section>
    </>
  );
}
