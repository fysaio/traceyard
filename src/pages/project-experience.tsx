import { REVIEWED_RUNNER_REVISION } from "../../shared/repository/runner-version";
import { ApiClientError } from "../lib/api";
import { SourceFlowTree } from "../components/source-flow";
import { useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Icon, Modal, ErrorMessage, downloadJson } from "../components/product-ui";
import { ConnectRepository } from "./project-overview";
import { useWorkspace } from "../lib/workspace";
import { integrationRequest, type SpanRecord } from "../lib/integrations-api";
import type {
  Catalog,
  Operation,
  ApplicationRun,
  RunnerConfig,
  SavedTestCase,
  TestResult,
  TestCaseInput,
} from "../../shared/repository/workspace";
import type { RepositoryJob } from "../../shared/repository/contracts";
import { checkDisplayStatus } from "../../shared/repository/check-status";
const projectPath = (id: string) => "/projects/" + encodeURIComponent(id);
const operationPath = (p: string, key: string) =>
  projectPath(p) + "/operations/" + encodeURIComponent(key);
const runPath = (p: string, id: string) => projectPath(p) + "/runs/" + encodeURIComponent(id);
const checkPath = (p: string, id: string) => projectPath(p) + "/checks/" + encodeURIComponent(id);
const stamp = (value: string | null) =>
  value
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "No runs yet";
const elapsed = (ms: number) =>
  ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(2) + " s";
const runDuration = (r: ApplicationRun) =>
  r.endedAt ? elapsed(Math.max(0, Date.parse(r.endedAt) - Date.parse(r.startedAt))) : "In progress";
async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" }),
    body = (await response.json()) as { data: T; error?: { message: string } };
  if (!response.ok) throw Error(body.error?.message ?? "Could not load this page.");
  return body.data;
}
function useCatalog(projectId: string) {
  return useQuery({
    queryKey: ["catalog", projectId],
    queryFn: () => integrationRequest<Catalog>(projectId, "catalog"),
    refetchInterval: 5000,
  });
}
export function RunStatus({ value }: { value: string }) {
  const failed = value === "FAILED",
    busy = ["RUNNING", "QUEUED", "DISCOVERING", "PREPARING"].includes(value);
  return (
    <span
      className={
        "flow-status " +
        (failed ? "failed" : busy ? "running" : value === "SUCCEEDED" ? "succeeded" : "neutral")
      }
    >
      <Icon
        name={
          failed
            ? "circle-xmark"
            : busy
              ? "circle-notch"
              : value === "SUCCEEDED"
                ? "circle-check"
                : "circle"
        }
      />
      {(
        {
          SUCCEEDED: "Completed",
          FAILED: "Failed",
          RUNNING: "Running",
          STALE: "Update overdue",
          QUEUED: "Queued",
          SKIPPED: "Not tested",
          CANCELLED: "Cancelled",
          DISCOVERING: "Discovering",
          PREPARING: "Preparing",
          READY: "Connected",
        } as Record<string, string>
      )[value] ?? value.toLowerCase()}
    </span>
  );
}
function Crumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav className="flow-crumbs" aria-label="Breadcrumb">
      <Link to="/projects">Repositories</Link>
      {items.map((item, i) => (
        <span key={i}>
          <Icon name="chevron-right" />
          {item.to ? (
            <Link to={item.to}>{item.label}</Link>
          ) : (
            <span aria-current="page">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
function PageHead({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flow-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="flow-actions">{actions}</div>}
    </div>
  );
}
function LoadingPage() {
  return (
    <div className="flow-loading" role="status">
      <div />
      <div />
      <div />
      <span className="sr-only">Loading your project…</span>
    </div>
  );
}
function Empty({
  icon = "layer-group",
  title,
  children,
  action,
}: {
  icon?: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flow-empty">
      <span className="flow-icon">
        <Icon name={icon} />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action && <div className="flow-actions">{action}</div>}
    </div>
  );
}
function LoadingError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="flow-surface">
      <ErrorMessage error={error} />
      <button className="btn" onClick={retry}>
        Try again
      </button>
    </div>
  );
}
interface ProjectCard {
  id: string;
  name: string;
  repository: string | null;
  discoveryStatus: string | null;
  setupState: string | null;
  runs: number;
  failed: number;
  lastRunAt: string | null;
  lastCheck: string | null;
}
export function ProjectsPage() {
  const { openCreateProject } = useWorkspace();
  const q = useQuery({
    queryKey: ["workspace-projects"],
    queryFn: () => request<{ items: ProjectCard[] }>("/api/workspace/projects"),
    refetchInterval: 5000,
  });
  const [connect, setConnect] = useState(false),
    [search, setSearch] = useState("");
  const hasConnectedRepo = q.data?.items.some((p) => Boolean(p.repository));
  const availableProjects =
    q.data?.items.filter(
      (p) => hasConnectedRepo || p.repository || p.name !== "Main project" || p.runs !== 0,
    ) ?? [];
  const items = availableProjects.filter((p) =>
    (p.repository ?? p.name).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="flow-page">
      <p className="flow-kicker">Your workspace</p>
      <PageHead
        title="Repositories"
        description="Connect a GitHub repository to investigate its code."
        actions={
          availableProjects.length > 0 && (
            <button className="btn primary" onClick={() => setConnect(true)}>
              <Icon name="plus" />
              Connect repo
            </button>
          )
        }
      />
      {!!availableProjects.length && (
        <div className="flow-toolbar">
          <label className="flow-search">
            <Icon name="magnifying-glass" />
            <input
              aria-label="Find a project"
              placeholder="Find a project"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <button className="btn quiet" onClick={openCreateProject}>
            Create a local project
          </button>
        </div>
      )}
      {q.isPending ? (
        <LoadingPage />
      ) : q.error ? (
        <LoadingError error={q.error} retry={() => void q.refetch()} />
      ) : !items.length ? (
        <Empty
          icon="code-branch"
          title={search ? "No matching projects" : "Connect a repository first"}
          action={
            <button
              className={search ? "btn" : "btn primary"}
              onClick={() => (search ? setSearch("") : setConnect(true))}
            >
              {search ? (
                "Clear search"
              ) : (
                <>
                  <i className="fa-brands fa-github" aria-hidden="true" /> Connect repo
                </>
              )}
            </button>
          }
        >
          {search
            ? "Try its name or repository."
            : "Choose a repository from GitHub. Traceyard will index its code so you can start an investigation."}
        </Empty>
      ) : (
        <div className="flow-projects">
          {items.map((p) => (
            <Link className="flow-project-card" key={p.id} to={projectPath(p.id)}>
              <div className="flow-card-top">
                <span className="flow-icon">
                  <Icon name={p.repository ? "code-branch" : "folder"} />
                </span>
                {p.lastCheck ? (
                  <span className="flow-check-status">
                    Last check <RunStatus value={p.lastCheck} />
                  </span>
                ) : p.discoveryStatus === "SUCCEEDED" ? (
                  <span className="flow-muted">Source indexed</span>
                ) : p.discoveryStatus ? (
                  <RunStatus value={p.discoveryStatus} />
                ) : (
                  <span className="flow-muted">Ready to connect</span>
                )}
              </div>
              <div>
                <h2>{p.repository ?? p.name}</h2>
                {p.repository && p.name !== p.repository && <p>{p.name}</p>}
              </div>
              {p.runs > 0 && (
                <div className="flow-project-health">
                  <span>
                    {p.runs} runtime {p.runs === 1 ? "recording" : "recordings"}
                  </span>
                  {p.failed > 0 && <span className="flow-error">{p.failed} failed</span>}
                </div>
              )}
              <div className="flow-card-footer">
                <span>{p.lastRunAt ? stamp(p.lastRunAt) : "No runtime recordings yet"}</span>
                <Icon name="arrow-right" />
              </div>
            </Link>
          ))}
        </div>
      )}
      {connect && (
        <ConnectRepository
          mode="github"
          close={() => setConnect(false)}
          connected={() => setConnect(false)}
        />
      )}
    </div>
  );
}
function SourceLink({ catalog, operation }: { catalog: Catalog; operation: Operation }) {
  const r = catalog.repository;
  return r?.repository_id && r.commit_sha && operation.file ? (
    <a
      className="btn"
      target="_blank"
      rel="noreferrer"
      href={`https://github.com/${r.full_name}/blob/${r.commit_sha}/${operation.file.split("/").map(encodeURIComponent).join("/")}#L${operation.line}`}
    >
      <Icon name="code" />
      View source
      <Icon name="arrow-up-right-from-square" />
    </a>
  ) : null;
}
function SetupProgress({ catalog, refresh }: { catalog: Catalog; refresh: () => void }) {
  const r = catalog.repository;
  const action = useMutation({
    mutationFn: () => integrationRequest(catalog.project.id, "repository/scan", "POST"),
    onSuccess: refresh,
  });
  if (!r?.repository_id || !["DISCOVERING", "FAILED"].includes(r.status)) return null;
  return (
    <section className="flow-setup-banner" aria-label="Source discovery">
      <div className="flow-setup-line">
        <span className="flow-icon">
          <Icon name={r.status === "DISCOVERING" ? "circle-notch" : "circle-exclamation"} />
        </span>
        <div>
          <h2>
            {r.status === "DISCOVERING" ? "Reading your repository" : "Source scan needs attention"}
          </h2>
          <p>
            {r.status === "DISCOVERING"
              ? "Operations appear as they are discovered. Existing discoveries stay available while this scan runs."
              : (r.last_error ??
                "The scan stopped. Existing discoveries and recorded runs are still available.")}
          </p>
        </div>
        {r.status === "FAILED" && (
          <button className="btn" disabled={action.isPending} onClick={() => action.mutate()}>
            {action.isPending ? "Starting…" : "Retry scan"}
          </button>
        )}
      </div>
      <ErrorMessage error={action.error} />
    </section>
  );
}
export function ProjectPage() {
  const { projectId } = useWorkspace(),
    q = useCatalog(projectId),
    cache = useQueryClient(),
    navigate = useNavigate(),
    checkRequest = useRef(crypto.randomUUID());
  const [search, setSearch] = useState(""),
    [onlyFailed, setOnlyFailed] = useState(false),
    [connect, setConnect] = useState(false),
    [settings, setSettings] = useState(false),
    [localCheck, setLocalCheck] = useState(false),
    [enableChecks, setEnableChecks] = useState(false);
  const run = useMutation({
    mutationFn: () =>
      integrationRequest<{ url: string }>(projectId, "repository/analyze", "POST", {
        requestId: checkRequest.current,
      }),
    onError: (error) => {
      if (error instanceof ApiClientError && error.code === "CI_SETUP_REQUIRED")
        setEnableChecks(true);
    },
    onSuccess: (result) => {
      checkRequest.current = crypto.randomUUID();
      void cache.invalidateQueries({ queryKey: ["catalog", projectId] });
      navigate(result.url);
    },
  });
  if (q.isPending) return <LoadingPage />;
  if (q.error || !q.data) return <LoadingError error={q.error} retry={() => void q.refetch()} />;
  const d = q.data,
    ops = d.operations.filter(
      (o) => (!onlyFailed || o.failed > 0) && o.name.toLowerCase().includes(search.toLowerCase()),
    );
  const latest = d.jobs[0],
    latestStatus = latest ? checkDisplayStatus(latest, q.dataUpdatedAt) : "",
    busy = ["RUNNING", "QUEUED"].includes(latestStatus);
  return (
    <div className="flow-page">
      <Crumbs items={[{ label: d.repository?.full_name ?? d.project.name }]} />
      <PageHead
        title={d.repository?.full_name ?? d.project.name}
        description={
          d.repository?.default_branch
            ? `${d.repository.default_branch} · ${d.repository.commit_sha?.slice(0, 7) ?? "Source discovery pending"}`
            : "Connect source, explore an operation, then inspect a run."
        }
        actions={
          <>
            <button className="btn" onClick={() => setSettings(true)}>
              <Icon name="sliders" />
              Test settings
            </button>
            {d.repository ? (
              <button
                className="btn primary"
                disabled={
                  run.isPending ||
                  (busy && !!d.executionAvailable) ||
                  (!!d.repository?.repository_id && !d.executionAvailable)
                }
                onClick={() => {
                  if (!d.repository?.repository_id) setLocalCheck(true);
                  else if (d.executionProvider === "github" && !d.repository.runner_enabled)
                    setEnableChecks(true);
                  else run.mutate();
                }}
              >
                <Icon name={busy ? "circle-notch" : "play"} />
                {!d.repository.repository_id
                  ? "Run locally"
                  : busy
                    ? "Checks in progress"
                    : "Run checks"}
              </button>
            ) : (
              <button className="btn primary" onClick={() => setConnect(true)}>
                <Icon name="code-branch" />
                Connect source
              </button>
            )}
          </>
        }
      />
      <ErrorMessage error={run.error} />
      <SetupProgress catalog={d} refresh={() => void q.refetch()} />
      {d.executionProvider === "github" && !d.repository?.runner_enabled && (
        <p className="flow-notice">
          Run checks on GitHub and view results here. The first run includes a one-time approval
          inside Traceyard.
        </p>
      )}
      {!!d.repository?.repository_id && !d.executionAvailable && (
        <p className="flow-notice">
          GitHub checks need server configuration. Source discoveries remain available.
        </p>
      )}
      {latest && (
        <Link className="flow-check-summary" to={checkPath(projectId, latest.id)}>
          <span className="flow-icon small">
            <Icon name="terminal" />
          </span>
          <div>
            <strong>{busy ? "Project checks are running" : "Latest project check"}</strong>
            <span>
              {latest.commit_sha?.slice(0, 7) ?? "Local directory"} · {stamp(latest.updated_at)}
            </span>
          </div>
          <RunStatus value={latestStatus} />
          <Icon name="chevron-right" />
        </Link>
      )}
      <section className="flow-section">
        <div className="flow-section-heading">
          <div>
            <h2>Operations</h2>
            <p>Choose a starting point in your application.</p>
          </div>
          <span className="flow-count">{d.operations.length}</span>
        </div>
        {!!d.operations.length && (
          <div className="flow-toolbar">
            <label className="flow-search">
              <Icon name="magnifying-glass" />
              <input
                aria-label="Find an operation"
                placeholder="Find an operation"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label className="flow-check-label">
              <input
                type="checkbox"
                checked={onlyFailed}
                onChange={(e) => setOnlyFailed(e.target.checked)}
              />
              Failed application runs
            </label>
          </div>
        )}
        {!ops.length ? (
          <Empty
            title={
              search || onlyFailed
                ? "No matching operations"
                : d.repository?.status === "DISCOVERING"
                  ? "Discovery is in progress"
                  : "No operations found yet"
            }
            action={
              search || onlyFailed ? (
                <button
                  className="btn"
                  onClick={() => {
                    setSearch("");
                    setOnlyFailed(false);
                  }}
                >
                  Clear filters
                </button>
              ) : undefined
            }
          >
            {onlyFailed
              ? "No operations match a failed application run. Build and test failures appear in the project check above. Clear filters to see discovered operations."
              : search
                ? "Try a different name or clear the filter."
                : "Supported source entry points and recorded application operations will appear here. Running tests only records the paths those tests exercise."}
          </Empty>
        ) : (
          <div className="flow-operations">
            {ops.map((o) => (
              <Link
                className="flow-operation-card"
                to={operationPath(projectId, o.key)}
                key={o.key}
              >
                <div className="flow-card-top">
                  <span className="flow-icon small">
                    <Icon
                      name={
                        o.kind === "http"
                          ? "arrow-right-arrow-left"
                          : o.kind === "job"
                            ? "clock"
                            : "wave-square"
                      }
                    />
                  </span>
                  <span className={o.failed ? "flow-error" : "flow-muted"}>
                    {o.failed
                      ? `${o.failed} failed`
                      : o.runs
                        ? `${o.runs} recorded runs`
                        : "Source available"}
                  </span>
                </div>
                <h3>{o.name}</h3>
                <p>{o.file ?? "Recorded from your application"}</p>
                <div className="flow-card-footer">
                  <span>
                    {o.evidence === "linked"
                      ? "Source linked to runs"
                      : o.evidence === "source"
                        ? "Discovered in source"
                        : "Recorded operation"}
                  </span>
                  <Icon name="arrow-right" />
                </div>
              </Link>
            ))}
          </div>
        )}
        {d.warnings.length > 0 && (
          <div className="flow-coverage">
            <Icon name="circle-info" />
            <p>{d.warnings.join(" ")}</p>
          </div>
        )}
      </section>
      <RunList
        projectId={projectId}
        runs={[...d.runs, ...(d.managedRuns ?? [])].sort((a, b) =>
          b.startedAt.localeCompare(a.startedAt),
        )}
        emptyAction={
          d.operations[0] && (
            <Link className="btn" to={operationPath(projectId, d.operations[0].key)}>
              Explore source flow
              <Icon name="arrow-right" />
            </Link>
          )
        }
      />
      <div className="flow-footer">
        <Link to={`/builder?project=${projectId}`}>
          Open Traceyard workflow builder
          <Icon name="arrow-right" />
        </Link>
        <Link to={`/settings/developer?project=${projectId}`}>Connection settings</Link>
      </div>
      {settings && (
        <TestSettings projectId={projectId} config={d.config} close={() => setSettings(false)} />
      )}
      {enableChecks && (
        <EnableGitHubChecks
          projectId={projectId}
          close={() => setEnableChecks(false)}
          onReady={() => {
            setEnableChecks(false);
            void q.refetch();
            run.mutate();
          }}
        />
      )}
      {localCheck && <LocalCheck projectId={projectId} close={() => setLocalCheck(false)} />}
      {connect && (
        <ConnectRepository
          projectId={projectId}
          attachToProject
          mode="github"
          close={() => setConnect(false)}
          connected={() => {
            setConnect(false);
            void q.refetch();
          }}
        />
      )}
    </div>
  );
}
function RunList({
  projectId,
  runs,
  title = "Recent runs",
  emptyTitle = "No application activity recorded yet",
  emptyDescription = "Source discovery lists possible operations. A recorded run appears when a test or your application actually exercises a supported operation.",
  emptyAction,
}: {
  projectId: string;
  runs: ApplicationRun[];
  title?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [failed, setFailed] = useState(false),
    [visible, setVisible] = useState(20);
  const rows = failed ? runs.filter((r) => r.status === "FAILED") : runs;
  return (
    <section className="flow-section">
      <div className="flow-section-heading">
        <div>
          <h2>{title}</h2>
          <p>Open a run to see what happened.</p>
        </div>
        <div className="flow-actions">
          {runs.length > 1 && (
            <Link
              className={"btn " + (selected.length !== 2 ? "disabled" : "")}
              aria-disabled={selected.length !== 2}
              tabIndex={selected.length !== 2 ? -1 : 0}
              onClick={(e) => {
                if (selected.length !== 2) e.preventDefault();
              }}
              to={
                projectPath(projectId) +
                "/compare?before=" +
                encodeURIComponent(selected[0] ?? "") +
                "&after=" +
                encodeURIComponent(selected[1] ?? "")
              }
            >
              Compare {selected.length > 0 ? `(${selected.length}/2)` : "runs"}
            </Link>
          )}
          {runs.length > 0 && (
            <button
              className={"btn quiet " + (failed ? "is-selected" : "")}
              aria-pressed={failed}
              onClick={() => setFailed(!failed)}
            >
              Failed only
            </button>
          )}
        </div>
      </div>
      {!rows.length ? (
        <Empty
          icon="wave-square"
          title={failed ? "No failed application runs" : emptyTitle}
          action={failed ? undefined : emptyAction}
        >
          {failed ? "There are no failed runs in this history." : emptyDescription}
        </Empty>
      ) : (
        <div className="flow-run-list">
          {rows.slice(0, visible).map((r) => (
            <div className="flow-run-row" key={r.id}>
              <label className="flow-run-select">
                <input
                  type="checkbox"
                  aria-label={"Compare run " + r.id}
                  checked={selected.includes(r.id)}
                  disabled={
                    r.source === "managed" || (!selected.includes(r.id) && selected.length >= 2)
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? [...selected, r.id] : selected.filter((id) => id !== r.id),
                    )
                  }
                />
              </label>
              <Link
                to={
                  r.source === "managed"
                    ? `/executions/${r.id}?project=${projectId}`
                    : runPath(projectId, r.id)
                }
              >
                <span className="flow-run-name">
                  <strong>{r.name}</strong>
                  <span>
                    {stamp(r.startedAt)} · {r.steps} {r.steps === 1 ? "step" : "steps"}
                  </span>
                </span>
                <span className="flow-run-time">{runDuration(r)}</span>
                <RunStatus value={r.status} />
                <Icon name="chevron-right" />
              </Link>
            </div>
          ))}
        </div>
      )}
      {rows.length > visible && (
        <button className="btn flow-space" onClick={() => setVisible(visible + 20)}>
          Show more runs
        </button>
      )}
      {runs.length >= 500 && (
        <p className="flow-note flow-space">This view covers the latest 500 recorded traces.</p>
      )}
    </section>
  );
}
interface OperationData extends Catalog {
  operation: Operation;
  cases: SavedTestCase[];
}
export function OperationPage() {
  const { projectId } = useWorkspace(),
    { operationKey = "" } = useParams(),
    cache = useQueryClient(),
    testRequest = useRef({ caseId: "", id: crypto.randomUUID() });
  const q = useQuery({
    queryKey: ["operation", projectId, operationKey],
    queryFn: () =>
      integrationRequest<OperationData>(
        projectId,
        "operations/" + encodeURIComponent(operationKey),
      ),
    refetchInterval: 5000,
  });
  const [newTest, setNewTest] = useState(false),
    [settings, setSettings] = useState(false),
    [notice, setNotice] = useState(""),
    [pendingDelete, setPendingDelete] = useState<SavedTestCase | null>(null),
    [localCase, setLocalCase] = useState<string | null>(null),
    [enableCase, setEnableCase] = useState<string | null>(null);
  const test = useMutation({
    mutationFn: (caseId: string) => {
      if (testRequest.current.caseId !== caseId)
        testRequest.current = { caseId, id: crypto.randomUUID() };
      return integrationRequest<{ url: string }>(
        projectId,
        `operations/${encodeURIComponent(operationKey)}/test`,
        "POST",
        { caseId, requestId: testRequest.current.id },
      );
    },
    onError: (error, caseId) => {
      if (error instanceof ApiClientError && error.code === "CI_SETUP_REQUIRED")
        setEnableCase(caseId);
    },
    onSuccess: () => {
      testRequest.current = { caseId: "", id: crypto.randomUUID() };
      setNotice("Test requested. Its check and recorded run will appear in this project.");
      void cache.invalidateQueries({ queryKey: ["catalog", projectId] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      integrationRequest(projectId, "cases/" + encodeURIComponent(id), "DELETE"),
    onSuccess: () => {
      setPendingDelete(null);
      void q.refetch();
    },
  });
  if (q.isPending) return <LoadingPage />;
  if (q.error || !q.data) return <LoadingError error={q.error} retry={() => void q.refetch()} />;
  const d = q.data,
    o = d.operation,
    canTest = o.kind === "http" && !!o.file;
  return (
    <div className="flow-page">
      <Crumbs items={[{ label: d.project.name, to: projectPath(projectId) }, { label: o.name }]} />
      <PageHead
        title={o.name}
        description={
          o.file ? `${o.file}:${o.line}` : "An operation recorded from your application."
        }
        actions={
          <>
            <SourceLink catalog={d} operation={o} />
            {canTest && (
              <button className="btn primary" onClick={() => setNewTest(true)}>
                <Icon name="plus" />
                Add request test
              </button>
            )}
          </>
        }
      />
      <div className="flow-evidence">
        <span>
          <Icon name={o.evidence === "linked" ? "link" : "code"} />
          {o.evidence === "linked"
            ? "Source linked to runtime evidence"
            : o.evidence === "source"
              ? "Source flow · Runtime recording optional"
              : "Runtime evidence · Source not linked"}
        </span>
        <span>
          {o.runs} recorded runs{o.failed > 0 ? ` · ${o.failed} failed` : ""}
        </span>
      </div>
      {o.file && (
        <section className="flow-surface flow-operation-map">
          <div className="flow-section-heading">
            <div>
              <h2>Source flow</h2>
              <p>
                Possible calls read from code. This view is available without running the
                application.
              </p>
            </div>
          </div>
          <div className="flow-entry-node">
            <span className="flow-icon">
              <Icon name={o.kind === "http" ? "arrow-right-to-bracket" : "clock"} />
            </span>
            <div>
              <span className="flow-muted">Entry point</span>
              <strong>{o.name}</strong>
            </div>
          </div>
          {o.sourceFlow?.steps.length ? (
            <SourceFlowTree flow={o.sourceFlow} file={o.file} />
          ) : o.calls.length > 0 ? (
            <div className="flow-call-grid">
              {o.calls.map((name, i) => (
                <div className="flow-call" key={i}>
                  <Icon name="code" />
                  <span>{name}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="flow-muted flow-space">
              No function calls were resolved for this entry point. Imported and dynamic
              implementations may be outside this scan.
            </p>
          )}
          <p className="flow-note flow-space">
            Call relationships are inferred from source; they do not establish execution order or
            prove that a branch ran. Imported and dynamic implementations are not expanded.
          </p>
        </section>
      )}
      <section className="flow-section">
        <div className="flow-section-heading">
          <div>
            <h2>Saved tests</h2>
            <p>
              {canTest
                ? "Requests run against your application inside the test runner."
                : "Run the project’s existing tests to exercise this operation."}
            </p>
          </div>
          {canTest && (
            <button className="btn quiet" onClick={() => setSettings(true)}>
              <Icon name="sliders" />
              Test settings
            </button>
          )}
        </div>
        <ErrorMessage error={test.error || remove.error} />
        {notice && (
          <p className="flow-notice" role="status">
            {notice} <Link to={projectPath(projectId)}>View project progress</Link>
          </p>
        )}
        {!d.cases.length ? (
          <div className="flow-inline-empty">
            <Icon name="flask" />
            <p>
              {canTest
                ? "Add a request and the result you expect. Startup settings tell the runner how to launch your application."
                : "This operation uses runtime recording. Its own test harness is not configured here."}
            </p>
            {canTest && (
              <button className="btn" onClick={() => setNewTest(true)}>
                Create first test
              </button>
            )}
          </div>
        ) : (
          <div className="flow-tests">
            {d.cases.map((c) => (
              <article className="flow-test-card" key={c.id}>
                <div>
                  <h3>{c.name}</h3>
                  <p>
                    <span className="flow-method">{c.method}</span> {c.path}
                  </p>
                  <span className="flow-muted">
                    Expect HTTP {c.expectedStatus}
                    {c.responsePath ? ` · Check ${c.responsePath}` : ""}
                  </span>
                </div>
                <div className="flow-actions">
                  <button
                    className="btn icon-only"
                    aria-label={"Delete test " + c.name}
                    disabled={remove.isPending}
                    onClick={() => setPendingDelete(c)}
                  >
                    <Icon name="trash-can" />
                  </button>
                  <button
                    className="btn primary"
                    disabled={
                      test.isPending || (!!d.repository?.repository_id && !d.executionAvailable)
                    }
                    onClick={() => {
                      if (d.executionProvider === "github" && !d.repository?.runner_enabled)
                        setEnableCase(c.id);
                      else if (d.executionAvailable) test.mutate(c.id);
                      else if (!d.repository?.repository_id) setLocalCase(c.id);
                    }}
                  >
                    <Icon name="play" />
                    {!d.repository?.repository_id
                      ? "Run locally"
                      : test.isPending
                        ? "Requesting…"
                        : "Run test"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <RunList projectId={projectId} runs={d.runs} title="Run history" />
      {newTest && (
        <CreateRequestTest
          projectId={projectId}
          operation={o}
          close={() => setNewTest(false)}
          saved={() => {
            setNewTest(false);
            void q.refetch();
          }}
        />
      )}
      {settings && (
        <TestSettings projectId={projectId} config={d.config} close={() => setSettings(false)} />
      )}
      {enableCase && (
        <EnableGitHubChecks
          projectId={projectId}
          close={() => setEnableCase(null)}
          onReady={() => {
            const id = enableCase;
            setEnableCase(null);
            test.mutate(id);
          }}
        />
      )}
      {localCase && (
        <LocalCheck projectId={projectId} caseId={localCase} close={() => setLocalCase(null)} />
      )}
      {pendingDelete && (
        <Modal title="Delete this saved test?" close={() => setPendingDelete(null)}>
          <p className="flow-note">
            {pendingDelete.name} will be removed. Its recorded run results remain available.
          </p>
          <ErrorMessage error={remove.error} />
          <div className="dialog-actions">
            <button className="btn" onClick={() => setPendingDelete(null)}>
              Keep test
            </button>
            <button
              className="btn primary"
              disabled={remove.isPending}
              onClick={() => remove.mutate(pendingDelete.id)}
            >
              {remove.isPending ? "Deleting…" : "Delete test"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
interface CISetupResult {
  state: "READY" | "PREPARING" | "AWAITING_MERGE" | "MERGING" | "BLOCKED" | "SETUP_REQUIRED";
  prNumber?: number;
  headSha?: string;
  workflow?: string;
  message?: string;
}
export function EnableGitHubChecks({
  enableOnly = false,
  projectId,
  close,
  onReady,
}: {
  enableOnly?: boolean;
  projectId: string;
  close: () => void;
  onReady: () => void;
}) {
  const prepared = useRef(false),
    finished = useRef(false),
    cache = useQueryClient();
  const setup = useQuery({
    queryKey: ["ci-setup", projectId],
    queryFn: async () => {
      const result = await integrationRequest<CISetupResult>(
        projectId,
        "repository/setup",
        prepared.current ? "GET" : "POST",
      );
      prepared.current = true;
      return result;
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
    refetchInterval: (q) =>
      ["PREPARING", "MERGING"].includes(q.state.data?.state ?? "") ? 10000 : false,
  });
  const approve = useMutation({
    mutationFn: () =>
      integrationRequest<CISetupResult>(projectId, "repository/enable", "POST", {
        prNumber: setup.data?.prNumber,
        headSha: setup.data?.headSha,
      }),
    onSuccess: (result) => {
      cache.setQueryData(["ci-setup", projectId], { ...setup.data, ...result });
      void setup.refetch();
    },
  });
  useEffect(() => {
    if (
      prepared.current &&
      !setup.isFetching &&
      !setup.error &&
      setup.data?.state === "READY" &&
      !finished.current
    ) {
      finished.current = true;
      onReady();
    }
  }, [setup.data, setup.isFetching, setup.error, onReady]);
  const busy =
    setup.isPending || ["PREPARING", "MERGING", "READY"].includes(setup.data?.state ?? "");
  return (
    <Modal title="Enable GitHub checks" close={close}>
      <div className="flow-local-check">
        <p>Traceyard runs your project on GitHub and brings the results back here.</p>
        {busy ? (
          <p role="status">
            <Icon name="circle-notch" />{" "}
            {setup.data?.state === "MERGING"
              ? "GitHub is processing the setup merge. Required checks and repository rules still apply."
              : setup.data?.state === "READY"
                ? "Execution is ready…"
                : "Preparing your setup change…"}
          </p>
        ) : (
          <>
            <div>
              <h3>One workflow file</h3>
              <p>
                Enable checks adds or updates <code>.github/workflows/traceyard.yml</code>.
                Traceyard handles the pull request and merge here when you approve.
              </p>
            </div>
            <p>
              The runner connects automatically and uses your GitHub Actions allowance. Each check
              has a 10-minute limit.
            </p>
            {setup.data?.workflow && (
              <details>
                <summary>Review the workflow</summary>
                <pre className="code">{setup.data.workflow}</pre>
              </details>
            )}
            {setup.data?.state === "BLOCKED" && (
              <p className="flow-notice" role="status">
                {setup.data.message ??
                  "GitHub requires reviews, checks or additional permissions before merging this setup."}
              </p>
            )}
          </>
        )}
        <ErrorMessage error={setup.error || approve.error} />
        <div className="dialog-actions">
          <button className="btn" onClick={close}>
            {busy ? "Close" : "Cancel"}
          </button>
          {setup.data?.headSha && !busy && (
            <button
              className="btn primary"
              disabled={approve.isPending}
              onClick={() => approve.mutate()}
            >
              {approve.isPending
                ? "Requesting merge…"
                : setup.data.state === "BLOCKED"
                  ? "Retry merge"
                  : enableOnly
                    ? "Enable test execution"
                    : "Enable and run"}
            </button>
          )}
          {(setup.error || setup.data?.state === "SETUP_REQUIRED") && (
            <button
              className="btn"
              disabled={setup.isFetching}
              onClick={() => {
                prepared.current = false;
                void setup.refetch();
              }}
            >
              Prepare again
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
function LocalCheck({
  projectId,
  caseId,
  close,
}: {
  projectId: string;
  caseId?: string;
  close: () => void;
}) {
  const [copied, setCopied] = useState(false),
    [commandCopied, setCommandCopied] = useState(false),
    [copyError, setCopyError] = useState(false),
    cache = useQueryClient();
  const key = useMutation({
    mutationFn: () =>
      integrationRequest<{ token: string }>(projectId, "keys", "POST", {
        name: "Local checks",
        scopes: ["traces:write"],
      }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["keys", projectId] });
    },
  });
  const environment = `TRACEYARD_ORIGIN=${window.location.origin}\nTRACEYARD_KEY=${key.data?.token ?? "<create a project key below>"}\n`,
    command =
      `npm exec --yes --ignore-scripts --package=git+https://github.com/fysaio/traceyard.git#${REVIEWED_RUNNER_REVISION} -- traceyard run .` +
      (caseId ? " --case " + caseId : "");
  return (
    <Modal title={caseId ? "Run this test locally" : "Run project checks locally"} close={close}>
      <div className="flow-local-check">
        <p>
          Your computer runs the code. Traceyard receives the discoveries and results. No GitHub
          pull request is needed.
        </p>
        <div>
          <h3>1. Connect this project</h3>
          <p>
            In your application's folder, add <code>.env.traceyard</code> to <code>.gitignore</code>
            . Save these values in <code>.env.traceyard</code>.
          </p>
          <pre className="code">{environment}</pre>
          {!key.data ? (
            <button className="btn" disabled={key.isPending} onClick={() => key.mutate()}>
              {key.isPending ? "Creating…" : "Create project key"}
            </button>
          ) : (
            <>
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(environment)
                    .then(() => {
                      setCopied(true);
                      setCopyError(false);
                    })
                    .catch(() => setCopyError(true));
                }}
              >
                {copied ? "Copied" : "Copy connection values"}
              </button>
              <p className="hint" role="status">
                This key is shown once and expires in 90 days. Manage it in API keys & SDK.
              </p>
              {copyError && (
                <p role="alert">
                  Copy the values above manually; clipboard access was unavailable.
                </p>
              )}
            </>
          )}
          <ErrorMessage error={key.error} />
        </div>
        <div>
          <h3>2. Run from your application's folder</h3>
          <p>
            Use Node.js 22.12+ and Git. This command downloads the pinned runner on first use; npm
            caches it afterward.
          </p>
          <pre className="code">{command}</pre>
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard
                .writeText(command)
                .then(() => setCommandCopied(true))
                .catch(() => setCopyError(true));
            }}
          >
            {commandCopied ? "Copied" : "Copy run command"}
          </button>
          <p>
            The runner installs locked npm dependencies and runs{" "}
            {caseId
              ? "this saved request against your application"
              : "your existing build and tests"}
            . Use your local test environment. Each command has a 3-minute limit.
          </p>
        </div>
        <p>
          Keep this project open to see progress. Only supported activity exercised by the test
          appears as recorded runs.
        </p>
      </div>
    </Modal>
  );
}
function TestSettings({
  projectId,
  config,
  close,
}: {
  projectId: string;
  config: RunnerConfig;
  close: () => void;
}) {
  const [value, setValue] = useState(config),
    cache = useQueryClient();
  const save = useMutation({
    mutationFn: () => integrationRequest(projectId, "runner-config", "PUT", value),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["catalog", projectId] });
      void cache.invalidateQueries({ queryKey: ["operation", projectId] });
      close();
    },
  });
  return (
    <Modal title="Application test settings" close={close}>
      <p className="flow-note">
        These settings are used by the next runner. Keep provider keys and database credentials in
        your test environment; don’t paste them here.
      </p>
      <form
        className="flow-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label>
          Application directory
          <input
            value={value.directory}
            placeholder="."
            onChange={(e) => setValue({ ...value, directory: e.target.value })}
            required
          />
          <span>Relative to the repository root. Use “.” for the root.</span>
        </label>
        <label>
          Startup script
          <input
            value={value.startScript}
            placeholder="e.g. start or start:test"
            onChange={(e) => setValue({ ...value, startScript: e.target.value })}
          />
          <span>The name of an existing npm script. Required for saved request tests.</span>
        </label>
        <label>
          Local test port
          <input
            type="number"
            min={1024}
            max={65535}
            inputMode="numeric"
            value={value.port}
            onChange={(e) => setValue({ ...value, port: Number(e.target.value) })}
          />
          <span>The runner sets PORT and waits up to 30 seconds for the application.</span>
        </label>
        <ErrorMessage error={save.error} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function CreateRequestTest({
  projectId,
  operation,
  close,
  saved,
}: {
  projectId: string;
  operation: Operation;
  close: () => void;
  saved: () => void;
}) {
  const parts = operation.name.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (.+)$/),
    [name, setName] = useState(""),
    [method, setMethod] = useState<TestCaseInput["method"]>(
      (parts?.[1] as TestCaseInput["method"]) ?? "GET",
    ),
    [path, setPath] = useState(parts?.[2] ?? "/"),
    [body, setBody] = useState("{}"),
    [status, setStatus] = useState(200),
    [responsePath, setResponsePath] = useState(""),
    [expected, setExpected] = useState("true"),
    [capture, setCapture] = useState(false),
    [inputError, setInputError] = useState("");
  const create = useMutation({
    mutationFn: (v: TestCaseInput) =>
      integrationRequest(
        projectId,
        `operations/${encodeURIComponent(operation.key)}/cases`,
        "POST",
        v,
      ),
    onSuccess: saved,
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    try {
      setInputError("");
      create.mutate({
        name,
        method,
        path,
        expectedStatus: status,
        captureResponse: capture,
        responsePath,
        ...(!["GET", "HEAD"].includes(method) ? { body: JSON.parse(body) } : {}),
        ...(responsePath ? { expectedValue: JSON.parse(expected) } : {}),
      });
    } catch {
      setInputError("Enter valid JSON for the request body and expected value.");
    }
  }
  return (
    <Modal title="Add a request test" close={close}>
      <p className="flow-note">
        Use test data. Requests target the runner’s local application, never a production URL.
        Redirects are not followed.
      </p>
      <form className="flow-form" onSubmit={submit}>
        <label>
          Test name
          <input
            required
            maxLength={100}
            placeholder="e.g. Accepts a valid request"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset className="flow-method-picker">
          <legend>Request method</legend>
          {(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={method === m}
              className={method === m ? "is-selected" : ""}
              onClick={() => setMethod(m)}
            >
              {m}
            </button>
          ))}
        </fieldset>
        <label>
          Request path
          <input
            required
            value={path}
            placeholder="/api/example"
            onChange={(e) => setPath(e.target.value)}
          />
          <span>Replace route parameters such as :id with a test value.</span>
        </label>
        {!["GET", "HEAD"].includes(method) && (
          <label>
            Request body
            <textarea
              rows={5}
              spellCheck={false}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
        )}
        <label>
          Expected HTTP status
          <input
            type="number"
            inputMode="numeric"
            min={100}
            max={599}
            value={status}
            onChange={(e) => setStatus(Number(e.target.value))}
          />
        </label>
        <label>
          Response field to check <span>Optional · JSON path such as data.ready</span>
          <input
            value={responsePath}
            placeholder="data.ready"
            onChange={(e) => setResponsePath(e.target.value)}
          />
        </label>
        {responsePath && (
          <label>
            Expected JSON value
            <input value={expected} onChange={(e) => setExpected(e.target.value)} />
          </label>
        )}
        <label className="flow-check-label">
          <input type="checkbox" checked={capture} onChange={(e) => setCapture(e.target.checked)} />
          <span>Save a redacted response preview with this test</span>
        </label>
        <ErrorMessage error={create.error || (inputError ? Error(inputError) : null)} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={create.isPending}>
            {create.isPending ? "Saving…" : "Save test"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
interface RunData {
  spans: SpanRecord[];
  tests: (TestResult & {
    checkId: string;
    request?: {
      method: string;
      path: string;
      body?: unknown;
      expectedStatus: number;
      responsePath?: string;
      expectedValue?: unknown;
    };
  })[];
}
function orderedSpans(spans: SpanRecord[]) {
  const byId = new Map(spans.map((s) => [s.span_id, s])),
    seen = new Set<string>(),
    rows: { span: SpanRecord; depth: number }[] = [];
  const visit = (s: SpanRecord, depth: number) => {
    if (seen.has(s.span_id)) return;
    seen.add(s.span_id);
    rows.push({ span: s, depth: Math.min(depth, 8) });
    spans.filter((x) => x.parent_span_id === s.span_id).forEach((x) => visit(x, depth + 1));
  };
  spans.filter((s) => !s.parent_span_id || !byId.has(s.parent_span_id)).forEach((s) => visit(s, 0));
  spans.forEach((s) => visit(s, 0));
  return rows;
}
export function ApplicationRunPage() {
  const { projectId } = useWorkspace(),
    { traceId = "" } = useParams(),
    [params, setParams] = useSearchParams();
  const q = useQuery({
      queryKey: ["application-run", projectId, traceId],
      queryFn: () =>
        integrationRequest<RunData>(projectId, "application-runs/" + encodeURIComponent(traceId)),
      refetchInterval: 5000,
    }),
    catalog = useCatalog(projectId);
  const [tab, setTab] = useState("details"),
    [copied, setCopied] = useState(false);
  if (q.isPending) return <LoadingPage />;
  if (q.error || !q.data) return <LoadingError error={q.error} retry={() => void q.refetch()} />;
  const d = q.data,
    rows = orderedSpans(d.spans),
    root = rows[0]?.span,
    active = d.spans.find((s) => s.span_id === params.get("step")) ?? root,
    run = catalog.data?.runs.find((r) => r.id === traceId),
    op = catalog.data?.operations.find((o) => o.key === run?.operationKey);
  if (!root || !active) return null;
  const start = Math.min(...d.spans.map((s) => Date.parse(s.started_at))),
    end = Math.max(...d.spans.map((s) => Date.parse(s.ended_at ?? s.started_at))),
    total = Math.max(1, end - start);
  const attrs = JSON.parse(active.attributes_json) as Record<string, unknown>,
    checkId = String(
      (JSON.parse(root.attributes_json) as Record<string, unknown>)["traceyard.run.id"] ?? "",
    );
  const savedRequest = active.span_id === root.span_id ? d.tests[0]?.request : null;
  const payload =
    tab === "input"
      ? (active.input_json ?? (savedRequest ? JSON.stringify(savedRequest) : null))
      : tab === "output"
        ? active.output_json
        : null;
  return (
    <div className="flow-page">
      <Crumbs
        items={[
          { label: catalog.data?.project.name ?? "Project", to: projectPath(projectId) },
          ...(op ? [{ label: op.name, to: operationPath(projectId, op.key) }] : []),
          { label: "Run" },
        ]}
      />
      <PageHead
        title={root.name}
        description={stamp(root.started_at)}
        actions={
          <>
            <button
              className="btn"
              onClick={() =>
                void navigator.clipboard.writeText(traceId).then(() => setCopied(true))
              }
            >
              <Icon name="copy" />
              {copied ? "Copied" : "Copy run ID"}
            </button>
            <button
              className="btn"
              onClick={() => downloadJson("traceyard-run-" + traceId + ".json", d)}
            >
              <Icon name="download" />
              Export
            </button>
          </>
        }
      />
      <div className="flow-run-facts">
        <RunStatus value={root.status} />
        <span>{elapsed(total)}</span>
        <span>{d.spans.length} recorded steps</span>
        {checkId && (
          <Link to={checkPath(projectId, checkId)}>
            Project check
            <Icon name="arrow-up-right-from-square" />
          </Link>
        )}
      </div>
      {!!d.tests.length && (
        <section className="flow-test-verdicts">
          {d.tests.map((t) => (
            <article className="flow-surface" key={t.caseId}>
              <div className="flow-section-heading">
                <h2>{t.name}</h2>
                <RunStatus value={t.status} />
              </div>
              {t.request && (
                <p className="flow-note">
                  <strong>{t.request.method}</strong> {t.request.path}
                </p>
              )}
              <div className="flow-assertions">
                {t.checks.map((c, i) => (
                  <p key={i}>
                    <Icon name={c.passed ? "circle-check" : "circle-xmark"} />
                    {c.name}
                  </p>
                ))}
              </div>
              {t.error && <p className="flow-error">{t.error}</p>}
              {t.responsePreview && (
                <div className="flow-response">
                  <h3>Saved response preview</h3>
                  <pre className="code">{t.responsePreview}</pre>
                </div>
              )}
            </article>
          ))}
        </section>
      )}
      <div className="flow-inspection">
        <section className="flow-surface flow-timeline">
          <div className="flow-section-heading">
            <div>
              <h2>Execution path</h2>
              <p>Actual timing and parent relationships.</p>
            </div>
            <span className="flow-muted">{elapsed(total)}</span>
          </div>
          <div className="flow-span-list">
            {rows.map(({ span: s, depth }) => {
              const duration = s.ended_at
                  ? Math.max(0, Date.parse(s.ended_at) - Date.parse(s.started_at))
                  : 0,
                offset = Math.max(0, Date.parse(s.started_at) - start);
              return (
                <button
                  key={s.span_id}
                  aria-pressed={active.span_id === s.span_id}
                  className={"flow-span " + (active.span_id === s.span_id ? "is-selected" : "")}
                  onClick={() => {
                    setParams({ step: s.span_id }, { replace: true });
                    setTab("details");
                  }}
                >
                  <span
                    className="flow-span-title"
                    style={{ paddingLeft: Math.min(depth, 4) * 14 }}
                  >
                    <Icon
                      name={
                        s.status === "FAILED"
                          ? "circle-xmark"
                          : s.kind === "http"
                            ? "arrow-right-arrow-left"
                            : "circle-check"
                      }
                    />
                    <strong>{s.name}</strong>
                    <span>{s.ended_at ? elapsed(duration) : "In progress"}</span>
                  </span>
                  <span className="flow-span-track" aria-hidden="true">
                    <span
                      className={s.status === "FAILED" ? "failed" : ""}
                      style={{
                        marginLeft: Math.min(99, (offset / total) * 100) + "%",
                        width:
                          Math.max(
                            0.5,
                            Math.min(100 - (offset / total) * 100, (duration / total) * 100),
                          ) + "%",
                      }}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
        <aside className="flow-surface flow-step-detail">
          <div className="flow-section-heading">
            <h2>{active.name}</h2>
            <RunStatus value={active.status} />
          </div>
          <div className="flow-tabs" role="tablist" aria-label="Step information">
            {["details", "input", "output"].map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? "is-selected" : ""}
                onClick={() => setTab(t)}
              >
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <div role="tabpanel">
            {tab === "details" ? (
              <>
                <dl className="flow-properties">
                  <div>
                    <dt>Operation</dt>
                    <dd>{active.kind}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>
                      {active.ended_at
                        ? elapsed(Date.parse(active.ended_at) - Date.parse(active.started_at))
                        : "In progress"}
                    </dd>
                  </div>
                  {Object.entries(attrs).map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                    </div>
                  ))}
                </dl>
                {active.error_json && (
                  <div className="flow-response">
                    <h3>Recorded error</h3>
                    <pre className="code">
                      {JSON.stringify(JSON.parse(active.error_json), null, 2)}
                    </pre>
                  </div>
                )}
              </>
            ) : payload ? (
              <pre className="code">{JSON.stringify(JSON.parse(payload), null, 2)}</pre>
            ) : (
              <p className="flow-inline-note">
                No {tab} payload was recorded for this step. Automatic recording excludes
                application payloads. Saved request tests can capture a redacted response preview
                when you enable it.
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
interface CheckData {
  job: RepositoryJob;
  tests: TestResult[];
  repository: { full_name: string; repository_id: number | null } | null;
}
export function ProjectCheckPage() {
  const { projectId } = useWorkspace(),
    { checkId = "" } = useParams();
  const q = useQuery({
      queryKey: ["check", projectId, checkId],
      queryFn: () =>
        integrationRequest<CheckData>(projectId, "checks/" + encodeURIComponent(checkId)),
      refetchInterval: 3000,
    }),
    catalog = useCatalog(projectId);
  const cancel = useMutation({
    mutationFn: () =>
      integrationRequest(projectId, "checks/" + encodeURIComponent(checkId) + "/cancel", "POST"),
  });
  if (q.isPending) return <LoadingPage />;
  if (q.error || !q.data) return <LoadingError error={q.error} retry={() => void q.refetch()} />;
  const d = q.data,
    events = JSON.parse(d.job.events_json) as {
      phase: string;
      status: string;
      message: string;
      at: string;
    }[];
  const displayStatus = checkDisplayStatus(d.job, q.dataUpdatedAt);
  const phases = [
    ...(d.job.source === "github-pending" ? ["dispatch"] : []),
    ...(d.job.source === "managed" ? ["checkout"] : []),
    "discovery",
    "install",
    "build",
    "test",
    "complete",
  ].map((name) => {
    const event =
      [...events].reverse().find((e) => e.phase === name) ??
      (name === "complete" && !["RUNNING", "QUEUED"].includes(d.job.status)
        ? {
            phase: "complete",
            status: d.job.status,
            message:
              d.job.source === "github"
                ? "The runner has ended. Open GitHub logs for the final command output."
                : "This check has ended. Review the reported stages above.",
            at: d.job.updated_at,
          }
        : undefined);
    return {
      name,
      event:
        event?.status === "RUNNING" && !["RUNNING", "QUEUED"].includes(displayStatus)
          ? {
              ...event,
              status: displayStatus === "SUCCEEDED" ? "SKIPPED" : displayStatus,
              message:
                displayStatus === "STALE"
                  ? "No recent runner update. The outcome has not been confirmed."
                  : "The check ended before a final update for this stage was received. See the result below.",
            }
          : event,
    };
  });
  return (
    <div className="flow-page">
      <Crumbs
        items={[
          { label: catalog.data?.project.name ?? "Project", to: projectPath(projectId) },
          { label: "Project check" },
        ]}
      />
      <PageHead
        title="Project check"
        description={`${d.job.commit_sha?.slice(0, 7) ?? (d.job.source === "github-pending" ? "Waiting for GitHub" : "Local directory")} · ${stamp(d.job.updated_at)}`}
        actions={
          d.job.github_url && (
            <a className="btn" href={d.job.github_url} target="_blank" rel="noreferrer">
              GitHub logs
              <Icon name="arrow-up-right-from-square" />
            </a>
          )
        }
      />
      <ErrorMessage error={cancel.error} />
      {cancel.isSuccess && (
        <p role="status" className="flow-notice">
          {d.job.source === "managed"
            ? "Check cancelled. Its discovered operations remain available."
            : "Cancellation requested. Waiting for GitHub to confirm it has stopped."}
        </p>
      )}
      {["github", "github-pending", "managed"].includes(d.job.source) &&
        ["RUNNING", "QUEUED"].includes(d.job.status) && (
          <button
            className="btn flow-space"
            disabled={cancel.isPending || cancel.isSuccess}
            onClick={() => cancel.mutate()}
          >
            Cancel check
          </button>
        )}
      <div className="flow-run-facts">
        <RunStatus value={displayStatus} />
        <span>
          {d.job.source === "managed"
            ? "Traceyard runner"
            : ["github", "github-pending"].includes(d.job.source)
              ? "GitHub runner"
              : "Local runner"}
        </span>
      </div>
      {displayStatus === "STALE" && (
        <p className="flow-notice" role="status">
          {d.job.source === "github"
            ? "No progress for over 15 minutes. This page checks GitHub automatically; open GitHub logs to verify the outcome."
            : "No recent runner update. This check's outcome is unconfirmed. Traceyard will close an expired check without repeating it automatically."}{" "}
          <button className="btn quiet" disabled={q.isFetching} onClick={() => void q.refetch()}>
            Refresh status
          </button>
        </p>
      )}
      <section className="flow-surface">
        <h2>Progress</h2>
        <ol className="flow-check-stages">
          {phases.map((p) => (
            <li key={p.name}>
              <span className="flow-stage-dot">
                <Icon
                  name={
                    !p.event
                      ? "circle"
                      : p.event.status === "FAILED"
                        ? "circle-xmark"
                        : p.event.status === "RUNNING"
                          ? "circle-notch"
                          : p.event.status === "SUCCEEDED"
                            ? "circle-check"
                            : "circle"
                  }
                />
              </span>
              <div>
                <h3>
                  {
                    (
                      {
                        dispatch: "Start GitHub runner",
                        checkout: "Download repository",
                        discovery: "Read source",
                        install: "Install dependencies",
                        build: "Build application",
                        test: "Run tests",
                        complete: "Finish",
                      } as Record<string, string>
                    )[p.name]
                  }
                </h3>
                <p>{p.event?.message ?? "Not reached"}</p>
              </div>
              {p.event && <RunStatus value={p.event.status} />}
            </li>
          ))}
        </ol>
      </section>
      <RunList
        projectId={projectId}
        runs={catalog.data?.runs.filter((r) => r.checkId === d.job.id) ?? []}
        title="Runs recorded during this check"
        emptyAction={
          catalog.data?.operations[0] && (
            <Link className="btn" to={operationPath(projectId, catalog.data.operations[0].key)}>
              Explore source flow
              <Icon name="arrow-right" />
            </Link>
          )
        }
        emptyTitle={
          ["RUNNING", "QUEUED"].includes(displayStatus)
            ? "No application activity recorded so far"
            : "No application activity was recorded"
        }
        emptyDescription={
          displayStatus === "STALE"
            ? "The check’s outcome could not be confirmed. Review its status before starting another attempt."
            : d.job.status === "FAILED"
              ? "This project check failed. Review the failed stage above, correct it, then run Check project again. A failed check and a failed application run are different results; tests that stop before requests or mock those requests may record no application activity."
              : d.job.status === "QUEUED"
                ? "This check is waiting for an isolated runner. Your source operations are available now."
                : d.job.status === "RUNNING"
                  ? "The check is still running. Application activity appears here when its tests make supported runtime calls."
                  : "The checks passed without exporting supported runtime activity. Source flows remain available from the project’s operations. A recorded run requires an actual supported execution."
        }
      />
    </div>
  );
}
export function RunComparePage() {
  const { projectId } = useWorkspace(),
    [params] = useSearchParams(),
    before = params.get("before") ?? "",
    after = params.get("after") ?? "";
  const a = useQuery({
      queryKey: ["application-run", projectId, before],
      queryFn: () =>
        integrationRequest<RunData>(projectId, "application-runs/" + encodeURIComponent(before)),
      enabled: !!before,
    }),
    b = useQuery({
      queryKey: ["application-run", projectId, after],
      queryFn: () =>
        integrationRequest<RunData>(projectId, "application-runs/" + encodeURIComponent(after)),
      enabled: !!after,
    });
  if ((before && a.isPending) || (after && b.isPending)) return <LoadingPage />;
  const rootA = a.data?.spans.find((s) => !s.parent_span_id) ?? a.data?.spans[0],
    rootB = b.data?.spans.find((s) => !s.parent_span_id) ?? b.data?.spans[0];
  return (
    <div className="flow-page">
      <Crumbs
        items={[{ label: "Project", to: projectPath(projectId) }, { label: "Compare runs" }]}
      />
      <PageHead
        title="Compare runs"
        description="Recorded status, timing and test results from two executions."
      />
      <ErrorMessage error={a.error || b.error} />
      {!rootA || !rootB ? (
        <Empty
          title="Choose two runs"
          action={
            <Link className="btn" to={projectPath(projectId)}>
              Back to project
            </Link>
          }
        >
          Select two runs in a project or operation’s history to compare them.
        </Empty>
      ) : (
        <div className="flow-compare">
          {[
            { label: "Earlier run", root: rootA, data: a.data!, id: before },
            { label: "Comparison run", root: rootB, data: b.data!, id: after },
          ].map((c) => (
            <section className="flow-surface" key={c.label}>
              <p className="flow-kicker">{c.label}</p>
              <h2>{c.root.name}</h2>
              <p className="flow-muted">{stamp(c.root.started_at)}</p>
              <div className="flow-run-facts">
                <RunStatus value={c.root.status} />
                <span>
                  {c.root.ended_at
                    ? elapsed(Date.parse(c.root.ended_at) - Date.parse(c.root.started_at))
                    : "In progress"}
                </span>
              </div>
              <p>{c.data.spans.length} recorded steps</p>
              {c.data.tests.map((t) => (
                <div className="flow-response" key={t.caseId}>
                  <h3>{t.name}</h3>
                  <RunStatus value={t.status} />
                  {t.checks.map((check, i) => (
                    <p className="flow-assertion" key={i}>
                      <Icon name={check.passed ? "circle-check" : "circle-xmark"} />
                      {check.name}
                    </p>
                  ))}
                </div>
              ))}
              <Link className="btn flow-space" to={runPath(projectId, c.id)}>
                Inspect run
                <Icon name="arrow-right" />
              </Link>
            </section>
          ))}
        </div>
      )}
      <p className="flow-note flow-space">
        A timing comparison does not establish a regression verdict. Different inputs, environments
        or recorded coverage can change the result.
      </p>
    </div>
  );
}
