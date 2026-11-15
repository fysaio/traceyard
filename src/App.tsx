import { Studio } from "./pages/studio";
import { studioApi } from "./lib/studio-api";
import { useState, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  readAllEvents,
  newIdempotencyKey,
  type AuthSession,
  type SavedWorkflowSummary,
} from "./lib/api";
import type { RunDetail, WorkflowSummary } from "../shared/contracts/api";
import {
  documentInputSchema,
  FAILURE_SCENARIOS,
  type FailureScenario,
} from "../shared/workflow/document";

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
        <h1>Understand every execution.</h1>
        <p>Build reliable workflows, investigate failures and see exactly what your systems do.</p>
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
      </main>
    </div>
  );
}
function Workspace({ session }: { session: AuthSession }) {
  const projects = useQuery({ queryKey: ["projects", session.user?.id], queryFn: api.projects });
  const [selectedProject, setProject] = useState("");
  const projectId = projects.data?.some((p) => p.id === selectedProject)
    ? selectedProject
    : (projects.data?.[0]?.id ?? "");
  const [newProject, setNewProject] = useState(false);
  const [name, setName] = useState("");
  const cache = useQueryClient();
  const create = useMutation({
    mutationFn: api.createProject,
    onSuccess: (p) => {
      setProject(p.id);
      setNewProject(false);
      setName("");
      void cache.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      cache.clear();
      void cache.invalidateQueries();
      window.location.assign("/");
    },
  });
  return (
    <div className="product-shell">
      <header className="product-header">
        <Link className="brand" to="/">
          Traceyard.
        </Link>
        <nav aria-label="Main navigation">
          {[
            ["/", "Workflows", "layer-group"],
            ["/executions", "Executions", "clock-rotate-left"],
            ["/laboratory", "Laboratory", "flask"],
            ["/settings", "Settings", "gear"],
          ].map(([path, text, icon]) => (
            <Link key={path} to={path!}>
              <Icon name={icon!} />
              <span>{text}</span>
            </Link>
          ))}
        </nav>
        <div className="header-tools">
          <label className="sr-only" htmlFor="project-switch">
            Current project
          </label>
          <select
            id="project-switch"
            value={projectId}
            onChange={(e) => setProject(e.target.value)}
            disabled={!projects.data?.length}
          >
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="btn icon-only"
            aria-label="Create project"
            onClick={() => setNewProject(!newProject)}
          >
            <Icon name="plus" />
          </button>
          <button className="btn" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Sign out
          </button>
        </div>
      </header>
      <main className="product-main">
        {projects.isPending ? (
          <Loading />
        ) : projects.isError ? (
          <Notice error={projects.error} retry={() => void projects.refetch()} />
        ) : (
          <>
            {newProject && (
              <form
                className="connected-panel inline-project"
                onSubmit={(e) => {
                  e.preventDefault();
                  create.mutate(name);
                }}
              >
                <label htmlFor="new-project">Project name</label>
                <input
                  id="new-project"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                />
                <div className="actions">
                  <button className="btn" type="button" onClick={() => setNewProject(false)}>
                    Cancel
                  </button>
                  <button className="btn primary" disabled={create.isPending}>
                    Create project
                  </button>
                </div>
                {create.isError && <Notice error={create.error} />}
              </form>
            )}
            <Routes>
              <Route path="/" element={<Workflows projectId={projectId} />} />
              <Route path="/workflows" element={<Navigate to="/" replace />} />
              <Route path="/workflow/:id" element={<Workflow projectId={projectId} />} />
              <Route
                path="/executions"
                element={<Executions key={projectId} projectId={projectId} />}
              />
              <Route path="/executions/:id" element={<Execution />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/laboratory" element={<Laboratory projectId={projectId} />} />
              <Route path="/studio/:id" element={<Studio projectId={projectId} />} />
              <Route path="/settings" element={<Settings session={session} />} />
              <Route
                path="*"
                element={
                  <Empty title="Page not found">
                    <Link to="/">Return to workflows</Link>
                  </Empty>
                }
              />
            </Routes>
          </>
        )}
        {logout.isError && <Notice error={logout.error} />}
      </main>
    </div>
  );
}
function Workflows({ projectId }: { projectId: string }) {
  const navigate = useNavigate(),
    cache = useQueryClient();
  const drafts = useQuery({
    queryKey: ["studio-list", projectId],
    queryFn: () => studioApi.list(projectId),
    enabled: !!projectId,
  });
  const create = useMutation({
    mutationFn: () => studioApi.create(projectId, "Untitled workflow"),
    onSuccess: (w) => {
      void cache.invalidateQueries({ queryKey: ["studio-list", projectId] });
      navigate("/studio/" + w.id);
    },
  });
  const archive = useMutation({
    mutationFn: (id: string) => studioApi.archive(projectId, id),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["studio-list", projectId] });
      void cache.invalidateQueries({ queryKey: ["workflows"] });
    },
  });
  const catalog = useQuery({
    queryKey: ["workflows", projectId],
    queryFn: () => api.workflows(projectId),
  });
  const saved = useQuery({
    queryKey: ["saved", projectId],
    queryFn: () => api.savedWorkflows(projectId),
    enabled: !!projectId,
  });
  const [layout, setLayout] = useState("grid"),
    [tab, setTab] = useState("catalog"),
    [search, setSearch] = useState(""),
    [launch, setLaunch] = useState<WorkflowSummary | null>(null);
  return (
    <>
      <Heading
        title="Workflows"
        actions={
          <button
            className="btn primary"
            disabled={create.isPending || !projectId}
            onClick={() => create.mutate()}
          >
            + Create workflow
          </button>
        }
      >
        Choose a published workflow and run it with your own input.
      </Heading>
      {(create.error || archive.error) && <Notice error={create.error || archive.error} />}
      {drafts.error && <Notice error={drafts.error} />}
      {!!drafts.data?.items.length && (
        <section className="connected-panel draft-library">
          <h2>Your workflow drafts</h2>
          {drafts.data.items.map((w) => (
            <div key={w.id} className="stat-row">
              <div>
                <strong>{w.name}</strong>
                <p>{w.current_version ? "Published v" + w.current_version : "Not published"}</p>
              </div>
              <div className="actions">
                <Link className="btn" to={"/studio/" + w.id}>
                  Edit in Studio
                </Link>
                <button
                  className="btn"
                  disabled={archive.isPending}
                  onClick={() => {
                    if (confirm("Archive " + w.name + "? Existing execution history is retained."))
                      archive.mutate(w.id);
                  }}
                >
                  Archive
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
      <div className="content-toolbar">
        <div className="product-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "catalog"} onClick={() => setTab("catalog")}>
            Published workflows
          </button>
          <button role="tab" aria-selected={tab === "saved"} onClick={() => setTab("saved")}>
            Saved configurations
          </button>
        </div>
        <div className="view-controls">
          <input
            className="search"
            aria-label="Search workflows"
            placeholder="Search workflows"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="segmented" role="group" aria-label="Workflow layout">
            {["list", "grid"].map((x) => (
              <button
                key={x}
                aria-pressed={layout === x}
                className={layout === x ? "selected" : ""}
                onClick={() => setLayout(x)}
              >
                <Icon name={x === "list" ? "list" : "border-all"} />
                {x === "list" ? "List view" : "Grid view"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {catalog.isPending ? (
        <Loading />
      ) : catalog.isError ? (
        <Notice error={catalog.error} retry={() => void catalog.refetch()} />
      ) : tab === "catalog" ? (
        <div className={`saved-workflows ${layout}`}>
          {catalog.data
            .filter((w) =>
              `${w.name} ${w.description}`.toLowerCase().includes(search.toLowerCase()),
            )
            .map((w) => (
              <article className="saved-workflow" key={w.id}>
                <Link to={`/workflow/${w.id}`} className="workflow-main">
                  <span className="workflow-icon">
                    <Icon name="file-lines" />
                  </span>
                  <div>
                    <h2>{w.name}</h2>
                    <p>{w.description}</p>
                    <div className="quiet-meta">
                      <span>Version {w.version}</span>
                      <span>{w.steps.length} steps</span>
                    </div>
                  </div>
                </Link>
                <div className="workflow-actions">
                  <Link className="btn" to={`/workflow/${w.id}`}>
                    Inspect
                  </Link>
                  <button className="btn primary" onClick={() => setLaunch(w)}>
                    <Icon name="play" /> Run
                  </button>
                </div>
              </article>
            ))}
        </div>
      ) : (
        <SavedConfigurations
          rows={saved.data ?? []}
          error={saved.error}
          loading={saved.isPending && !!projectId}
          projectId={projectId}
          catalog={catalog.data}
          search={search}
        />
      )}
      {launch && <Launch workflow={launch} projectId={projectId} close={() => setLaunch(null)} />}
    </>
  );
}
function SavedConfigurations({
  rows,
  error,
  loading,
  projectId,
  catalog,
  search,
}: {
  rows: SavedWorkflowSummary[];
  error: unknown;
  loading: boolean;
  projectId: string;
  catalog: WorkflowSummary[];
  search: string;
}) {
  const [launch, setLaunch] = useState<SavedWorkflowSummary | null>(null);
  const [target, setTarget] = useState<WorkflowSummary | null>(null);
  const open = useMutation({
    mutationFn: async (row: SavedWorkflowSummary) => {
      const definition = row.definition as Record<string, unknown>;
      return api.workflow(
        String(definition.runtimeWorkflowId),
        projectId,
        Number(definition.runtimeVersion),
      );
    },
    onSuccess: (workflow, row) => {
      setTarget(workflow);
      setLaunch(row);
    },
  });
  const cache = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSavedWorkflow(projectId, id),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["saved", projectId] }),
  });
  if (loading) return <Loading />;
  if (error) return <Notice error={error} />;
  const runtimeId = (row: SavedWorkflowSummary) =>
    typeof row.definition === "object" &&
    row.definition !== null &&
    "runtimeWorkflowId" in row.definition
      ? String(row.definition.runtimeWorkflowId)
      : "";
  const compatible = (row: SavedWorkflowSummary) =>
    catalog.find(
      (w) =>
        w.id === runtimeId(row) &&
        Number.isSafeInteger((row.definition as Record<string, unknown>).runtimeVersion) &&
        Number((row.definition as Record<string, unknown>).runtimeVersion) > 0,
    );
  return (
    <>
      {rows.length === 0 ? (
        <Empty title="No saved configurations">
          Run a published workflow and save its input to reuse it here.
        </Empty>
      ) : (
        <div className="saved-workflows list">
          {rows
            .filter((w) => w.name.toLowerCase().includes(search.toLowerCase()))
            .map((w) => (
              <article key={w.id} className="saved-workflow">
                <div className="workflow-main">
                  <span className="workflow-icon">
                    <Icon name="bookmark" />
                  </span>
                  <div>
                    <h2>{w.name}</h2>
                    <p>{w.description}</p>
                    {!compatible(w) && (
                      <p className="hint">
                        This definition has no matching published runtime version.
                      </p>
                    )}
                  </div>
                </div>
                <div className="workflow-actions">
                  <button
                    className="btn"
                    disabled={!compatible(w) || open.isPending}
                    onClick={() => open.mutate(w)}
                  >
                    Run
                  </button>
                  <button
                    className="btn"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (confirm(`Delete saved configuration “${w.name}”?`)) remove.mutate(w.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
        </div>
      )}
      {remove.isError && <Notice error={remove.error} />}
      {open.isError && <Notice error={open.error} />}
      {launch && target && (
        <Launch
          workflow={target}
          projectId={projectId}
          initialInput={(launch.definition as Record<string, unknown>).input}
          close={() => setLaunch(null)}
        />
      )}
    </>
  );
}
function Workflow({ projectId }: { projectId: string }) {
  const [searchParams] = useSearchParams();
  const version = searchParams.has("version") ? Number(searchParams.get("version")) : undefined;
  const { id = "" } = useParams();
  const workflow = useQuery({
    queryKey: ["workflow", id, projectId, version],
    queryFn: () => api.workflow(id, projectId, version),
  });
  const [launch, setLaunch] = useState(false);
  if (workflow.isPending) return <Loading />;
  if (workflow.isError) return <Notice error={workflow.error} />;
  const w = workflow.data;
  return (
    <>
      <Link className="back" to="/">
        ← Workflows
      </Link>
      <Heading
        title={w.name}
        actions={
          <button className="btn primary" onClick={() => setLaunch(true)}>
            <Icon name="play" /> Run workflow
          </button>
        }
      >
        {w.description}
      </Heading>
      <p className="hint">
        Published version {w.version}.{" "}
        {w.graph
          ? "This graph runs in the durable workflow engine."
          : "This pipeline performs deterministic document processing."}
      </p>
      <div className="runtime-steps">
        {w.steps.map((s, i) => (
          <article className="connected-panel" key={s.key}>
            <span className="step-number">{i + 1}</span>
            <div>
              <h2>{s.name}</h2>
              <p>{s.description}</p>
              <div className="quiet-meta">
                <span>{s.timeoutMs / 1000}s timeout</span>
                <span>Up to {s.retry.maxAttempts} attempts</span>
              </div>
            </div>
          </article>
        ))}
      </div>
      {launch && <Launch workflow={w} projectId={projectId} close={() => setLaunch(false)} />}
    </>
  );
}
function Launch({
  workflow,
  projectId,
  close,
  initialInput,
  fault = "success",
}: {
  workflow: WorkflowSummary;
  projectId?: string;
  close: () => void;
  initialInput?: unknown;
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
  const [graphInput, setGraphInput] = useState(JSON.stringify(initialInput ?? {}, null, 2));
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
          version: workflow.version,
          input: inputValue(),
          scenario: fault,
        },
        idempotencyKey,
      ),
    onSuccess: (result) => {
      void cache.invalidateQueries({ queryKey: ["runs"] });
      navigate(`/executions/${result.result.run.id}`);
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
function Executions({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState("");
  const runs = useQuery({
    queryKey: ["runs", projectId, status],
    queryFn: () =>
      api.runs({ projectId, ...(status ? { status: status as RunDetail["status"] } : {}) }),
    refetchInterval: 2500,
  });
  const [cursor, setCursor] = useState<string | null>(null);
  const more = useQuery({
    queryKey: ["run-page", projectId, status, cursor],
    queryFn: () =>
      api.runs({
        ...(status ? { status: status as RunDetail["status"] } : {}),
        projectId,
        cursor: cursor!,
        limit: 25,
      }),
    enabled: !!cursor,
  });
  const data = cursor ? more : runs;
  return (
    <>
      <Heading
        title="Executions"
        actions={
          <Link className="btn" to="/analytics">
            Account analytics
          </Link>
        }
      >
        Persisted execution history for the selected project.
      </Heading>
      <div className="content-toolbar">
        <div className="field">
          <label htmlFor="run-status">Status</label>
          <select
            id="run-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setCursor(null);
            }}
          >
            <option value="">All statuses</option>
            {["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLING", "CANCELLED"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <button className="btn" onClick={() => void data.refetch()}>
          Refresh
        </button>
      </div>
      {data.isPending ? (
        <Loading />
      ) : data.isError ? (
        <Notice error={data.error} />
      ) : data.data.items.length === 0 ? (
        <Empty title="No executions yet">
          Open a published workflow and run it with a document.
        </Empty>
      ) : (
        <div className="execution-list">
          {data.data.items.map((r) => (
            <Link key={r.id} className="execution-item connected-panel" to={`/executions/${r.id}`}>
              <div>
                <h2>{r.workflow.name}</h2>
                <p>{new Date(r.createdAt).toLocaleString()}</p>
              </div>
              <Status value={r.status} />
              <span>{duration(r.durationMs)}</span>
              <Icon name="arrow-right" />
            </Link>
          ))}
        </div>
      )}
      <div className="actions pagination">
        {cursor && (
          <button className="btn" onClick={() => setCursor(null)}>
            Latest executions
          </button>
        )}
        {data.data?.nextCursor && (
          <button className="btn" onClick={() => setCursor(data.data!.nextCursor)}>
            Older executions
          </button>
        )}
      </div>
    </>
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
    [step, setStep] = useState<string | null>(null),
    [walk, setWalk] = useState(false);
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
    mutationFn: () => api.retry(id),
    onSuccess: (result) => {
      setStep(null);
      setTab("summary");
      navigate(`/executions/${result.run.id}`);
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
            {r.status === "FAILED" && (
              <button
                className="btn primary"
                disabled={retry.isPending}
                onClick={() => retry.mutate()}
              >
                Retry execution
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
      </div>
      {r.parentRunId && (
        <Link to={`/executions/${r.parentRunId}`} className="text-link">
          Original execution
        </Link>
      )}
      {r.error && <Notice error={new Error(r.error.message)} />}
      {cancel.isError && <Notice error={cancel.error} />}
      {retry.isError && <Notice error={retry.error} />}
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
                      {duration(s.durationMs)} · {s.attemptCount} attempts
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
function Laboratory({ projectId }: { projectId: string }) {
  const workflows = useQuery({
    queryKey: ["workflows", projectId],
    queryFn: () => api.workflows(projectId),
  });
  const [fault, setFault] = useState<FailureScenario>("retryable_failure"),
    [launch, setLaunch] = useState(false);
  return (
    <>
      <Heading title="Laboratory">
        Inspect how the registered workflow handles a controlled failure.
      </Heading>
      <section className="connected-panel">
        <h2>Document workflow fault test</h2>
        <p>
          These scenarios run through the real queue, workflow engine and database. Failure
          injection is deliberate; there is no external model call.
        </p>
        <div className="field">
          <label htmlFor="fault">Scenario</label>
          <select
            id="fault"
            value={fault}
            onChange={(e) => setFault(e.target.value as FailureScenario)}
          >
            {FAILURE_SCENARIOS.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </div>
        <button
          className="btn primary"
          disabled={!workflows.data?.find((w) => w.slug === "document-intelligence")}
          onClick={() => setLaunch(true)}
        >
          Configure execution
        </button>
        {workflows.isError && <Notice error={workflows.error} />}
      </section>
      {launch && workflows.data?.find((w) => w.slug === "document-intelligence") && (
        <Launch
          projectId={projectId}
          workflow={workflows.data.find((w) => w.slug === "document-intelligence")!}
          fault={fault}
          close={() => setLaunch(false)}
        />
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
      <section className="connected-panel section">
        <h2>Available capabilities</h2>
        <p>
          Published document workflows execute in Cloudflare Workflows and persist their results in
          D1. Saved configurations are stored in your project.
        </p>
        <p>
          Studio publishes versioned data workflows. Model providers, approval tasks and webhooks
          are still being implemented.
        </p>
      </section>
    </>
  );
}

function Analytics() {
  const [days, setDays] = useState(14);
  const query = useQuery({
    queryKey: ["analytics", days],
    queryFn: () => api.analytics(days),
    refetchInterval: 30000,
  });
  return (
    <>
      <Link className="back" to="/executions">
        ← Executions
      </Link>
      <Heading title="Account analytics">
        Metrics from persisted executions across your account.
      </Heading>
      <div className="field">
        <label htmlFor="analytics-days">Time window</label>
        <select id="analytics-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 14, 30].map((n) => (
            <option key={n} value={n}>
              Last {n} days
            </option>
          ))}
        </select>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Notice error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <div className="metrics">
            {[
              ["Window", query.data.windowDays + " days"],
              [
                "Throughput",
                query.data.throughputPerDay === null
                  ? "—"
                  : query.data.throughputPerDay.toFixed(1) + " / day",
              ],
              ["Execution p95", duration(query.data.executionDuration.p95Ms)],
              ["Queue p95", duration(query.data.queueDelay.p95Ms)],
            ].map(([name, value]) => (
              <div key={name}>
                <span>{name}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <section className="connected-panel">
            <h2>Execution history</h2>
            <div className="analytics-table">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Runs</th>
                    <th>Succeeded</th>
                    <th>Failed</th>
                    <th>Cancelled</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.trend.map((row) => (
                    <tr key={row.date}>
                      <td>{row.date}</td>
                      <td>{row.total}</td>
                      <td>{row.succeeded}</td>
                      <td>{row.failed}</td>
                      <td>{row.cancelled}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="connected-panel section">
            <h2>Failure classes</h2>
            {query.data.failureClasses.length ? (
              query.data.failureClasses.map((row) => (
                <div className="stat-row" key={row.class}>
                  <strong>{row.class}</strong>
                  <span>{row.count}</span>
                </div>
              ))
            ) : (
              <p>No recorded failures in this window.</p>
            )}
          </section>
          <section className="connected-panel section">
            <h2>Step performance</h2>
            {query.data.stepDurations.length ? (
              query.data.stepDurations.map((row) => (
                <div className="stat-row" key={row.stepKey}>
                  <strong>{row.name}</strong>
                  <span>
                    {row.sampleSize} samples · p95 {duration(row.p95Ms)}
                  </span>
                </div>
              ))
            ) : (
              <p>Complete a workflow to see step timings.</p>
            )}
          </section>
        </>
      )}
    </>
  );
}
