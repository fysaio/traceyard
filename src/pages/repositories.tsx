import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ProjectLink as Link } from "../components/project-link";
import {
  Badge,
  Empty,
  ErrorMessage,
  GitHubMark,
  Icon,
  Modal,
  PageHeader,
  Spinner,
  formatTime,
  shortSha,
  type Tone,
} from "../components/ui";
import {
  RepositoryPicker,
  type RepositoryChoice,
  type RepositoryChoices,
} from "../components/repository-picker";
import { ApiClientError, type ProjectSummary } from "../lib/api";
import { integrationRequest } from "../lib/integrations-api";
import { savePreference, useWorkspace } from "../lib/workspace";
import type { Catalog, RunnerConfig } from "../../shared/repository/workspace";
import type { RepositoryJob } from "../../shared/repository/contracts";
import { checkDisplayStatus } from "../../shared/repository/check-status";

export const repositoryPath = (id: string) => "/repositories/" + encodeURIComponent(id);
const checkPath = (p: string, id: string) =>
  repositoryPath(p) + "/checks/" + encodeURIComponent(id);

const STATUS: Record<string, [label: string, tone: Tone]> = {
  SUCCEEDED: ["Passed", "pass"],
  FAILED: ["Failed", "fail"],
  RUNNING: ["Running", "running"],
  QUEUED: ["Queued", "running"],
  DISCOVERING: ["Reading code", "running"],
  PREPARING: ["Preparing", "running"],
  STALE: ["No recent update", "warn"],
  SKIPPED: ["Skipped", "neutral"],
  CANCELLED: ["Cancelled", "neutral"],
  READY: ["Ready", "pass"],
};

export function CheckStatus({ value }: { value: string }) {
  const [label, tone] = STATUS[value] ?? [value.toLowerCase().replaceAll("_", " "), "neutral"];
  return <Badge tone={tone}>{label}</Badge>;
}

export interface CISetupResult {
  state: "READY" | "PREPARING" | "AWAITING_MERGE" | "SETUP_REQUIRED";
  prUrl?: string;
  previewKey?: string;
  defaultBranch?: string;
  workflow?: string;
  previousWorkflow?: string | null;
}

interface RepositoryCard {
  id: string;
  name: string;
  repository: string | null;
  discoveryStatus: string | null;
  lastCheck: string | null;
  lastCheckAt: string | null;
}

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

export function RepositoriesPage() {
  const { openConnect } = useWorkspace();
  const q = useQuery({
    queryKey: ["workspace-projects"],
    queryFn: () => request<{ items: RepositoryCard[] }>("/api/workspace/projects"),
    refetchInterval: 5000,
  });
  const [search, setSearch] = useState("");
  const all = q.data?.items.filter((p) => p.repository) ?? [];
  const items = all.filter((p) =>
    p.repository!.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <div className="page">
      <PageHeader
        title="Repositories"
        description="Traceyard reads each repository and runs its existing tests."
        actions={
          all.length > 0 && (
            <button className="btn primary" onClick={openConnect}>
              <Icon name="plus" />
              Connect repository
            </button>
          )
        }
      />
      {q.isPending ? (
        <Spinner label="Loading repositories…" />
      ) : q.error ? (
        <ErrorMessage error={q.error} />
      ) : !all.length ? (
        <Empty
          title="No repositories yet"
          action={
            <button className="btn primary" onClick={openConnect}>
              <GitHubMark /> Connect repository
            </button>
          }
        >
          Choose a repository on GitHub. Traceyard indexes its code and finds your tests.
        </Empty>
      ) : (
        <div className="stack">
          {all.length > 5 && (
            <label className="search">
              <Icon name="search" />
              <input
                type="search"
                aria-label="Find a repository"
                placeholder="Find a repository"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          )}
          {items.length ? (
            <div className="list">
              {items.map((p) => (
                <Link className="row link" key={p.id} to={repositoryPath(p.id)}>
                  <Icon name="repository" />
                  <div className="row-main">
                    <strong className="truncate">{p.repository}</strong>
                    {p.lastCheck ? (
                      <span className="muted">
                        {["RUNNING", "QUEUED", "DISCOVERING", "PREPARING"].includes(p.lastCheck)
                          ? "Current check"
                          : "Latest check"}
                        {p.lastCheckAt ? ` · ${formatTime(p.lastCheckAt)}` : ""}
                      </span>
                    ) : p.discoveryStatus && p.discoveryStatus !== "SUCCEEDED" ? (
                      <span className="muted">Repository setup</span>
                    ) : (
                      <span className="muted">No checks have run</span>
                    )}
                  </div>
                  {p.lastCheck ? (
                    <CheckStatus value={p.lastCheck} />
                  ) : p.discoveryStatus && p.discoveryStatus !== "SUCCEEDED" ? (
                    <CheckStatus value={p.discoveryStatus} />
                  ) : (
                    <span className="muted">No checks yet</span>
                  )}
                  <Icon name="chevron-right" />
                </Link>
              ))}
            </div>
          ) : (
            <p className="muted">
              No repositories match “{search}”. Try a shorter name or clear the search.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function RepositoryPage() {
  const { projectId } = useWorkspace(),
    q = useCatalog(projectId),
    cache = useQueryClient(),
    navigate = useNavigate(),
    checkRequest = useRef(crypto.randomUUID());
  const [connect, setConnect] = useState(false),
    [settings, setSettings] = useState(false),
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
      navigate(result.url.replace(/^\/projects\//, "/repositories/"));
    },
  });
  const scan = useMutation({
    mutationFn: () => integrationRequest(projectId, "repository/scan", "POST"),
    onSuccess: () => void q.refetch(),
  });
  if (q.isPending) return <Spinner label="Loading repository…" />;
  if (q.error || !q.data)
    return (
      <div className="page stack">
        <ErrorMessage error={q.error} />
        <div>
          <button className="btn" onClick={() => void q.refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  const d = q.data,
    r = d.repository;
  const latest = d.jobs[0],
    latestStatus = latest ? checkDisplayStatus(latest, q.dataUpdatedAt) : "",
    busy = ["RUNNING", "QUEUED"].includes(latestStatus);
  const ready =
    !!d.executionAvailable && (d.executionProvider === "managed" || !!r?.runner_enabled);

  if (!r?.repository_id)
    return (
      <div className="page">
        <BackLink to="/repositories">Repositories</BackLink>
        <Empty
          title="This project has no repository"
          action={
            <button className="btn primary" onClick={() => setConnect(true)}>
              <GitHubMark /> Connect repository
            </button>
          }
        >
          Connect a GitHub repository to run its tests from Traceyard.
        </Empty>
        {connect && (
          <ConnectRepository
            projectId={projectId}
            close={() => setConnect(false)}
            connected={() => {
              setConnect(false);
              void q.refetch();
            }}
          />
        )}
      </div>
    );

  return (
    <div className="page">
      <BackLink to="/repositories">Repositories</BackLink>
      <PageHeader
        title={r.full_name}
        description={
          <span className="meta">
            <Icon name="branch" />
            {r.default_branch ?? "default branch"}
            {r.commit_sha && <code>{shortSha(r.commit_sha)}</code>}
            {d.filesScanned > 0 && <span>{d.filesScanned.toLocaleString()} files read</span>}
          </span>
        }
        actions={
          <>
            <button className="btn" onClick={() => setSettings(true)}>
              <Icon name="sliders" />
              Test settings
            </button>
            <button
              className="btn primary"
              disabled={run.isPending || busy || !d.executionAvailable}
              onClick={() =>
                d.executionProvider === "github" && !r.runner_enabled
                  ? setEnableChecks(true)
                  : run.mutate()
              }
            >
              <Icon name={busy || run.isPending ? "spinner" : "arrow-right"} />
              {busy ? "Check running" : "Run checks"}
            </button>
          </>
        }
      />
      <div className="stack-lg">
        <ErrorMessage error={run.error} />
        {r.status === "DISCOVERING" && (
          <p className="notice" role="status">
            <Icon name="spinner" />
            <span>Reading the repository. Tests show up as Traceyard finds them.</span>
          </p>
        )}
        {r.status === "FAILED" && (
          <div className="notice danger">
            <Icon name="alert" />
            <span>
              {r.last_error ?? "Traceyard stopped reading the repository before it finished."}
            </span>
            <button className="btn" disabled={scan.isPending} onClick={() => scan.mutate()}>
              {scan.isPending ? "Starting…" : "Retry"}
            </button>
          </div>
        )}
        <ErrorMessage error={scan.error} />

        <section className="card setting-row">
          <div>
            <h2>Where tests run</h2>
            <p className="muted">
              {!d.executionAvailable
                ? "Running tests isn’t available on this server yet."
                : ready
                  ? d.executionProvider === "managed"
                    ? "Tests run on the Traceyard runner."
                    : "Tests run in GitHub Actions and count toward your Actions minutes."
                  : "Merge a small workflow file into your default branch to run tests in GitHub Actions."}
            </p>
          </div>
          {d.executionAvailable && d.executionProvider === "github" && (
            <button className={ready ? "btn" : "btn primary"} onClick={() => setEnableChecks(true)}>
              {ready ? "Review setup" : "Set up"}
            </button>
          )}
        </section>

        <section className="stack">
          <h2 className="section-title">Checks</h2>
          {d.jobs.length ? (
            <div className="list">
              {d.jobs.slice(0, 10).map((job, index) => (
                <Link className="row link" key={job.id} to={checkPath(projectId, job.id)}>
                  <code className="sha">{shortSha(job.commit_sha) ?? "Local"}</code>
                  <div className="row-main">
                    <span className="muted">{formatTime(job.updated_at)}</span>
                  </div>
                  <CheckStatus
                    value={index === 0 ? latestStatus : checkDisplayStatus(job, q.dataUpdatedAt)}
                  />
                  <Icon name="chevron-right" />
                </Link>
              ))}
            </div>
          ) : (
            <p className="muted">
              No checks yet. Run checks to install, build and run your whole test suite once.
            </p>
          )}
        </section>

        {d.warnings.length > 0 && (
          <details className="disclosure">
            <summary>
              <Icon name="chevron-right" />
              Files Traceyard skipped ({d.warnings.length})
            </summary>
            <ul className="bullets">
              {d.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
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
          }}
        />
      )}
    </div>
  );
}

function BackLink({ to, children }: { to: string; children: string }) {
  return (
    <Link className="back" to={to}>
      <Icon name="arrow-left" />
      {children}
    </Link>
  );
}

const STAGES: Record<string, string> = {
  dispatch: "Start GitHub runner",
  checkout: "Download repository",
  discovery: "Read source",
  install: "Install dependencies",
  build: "Build",
  test: "Run tests",
  complete: "Finish",
};

const stageLabel = (name: string, message?: string) =>
  name === "build" && /selected test directly/i.test(message ?? "")
    ? "Prepare selected test"
    : STAGES[name];

interface CheckData {
  job: RepositoryJob;
  repository: { full_name: string; repository_id: number | null } | null;
}

export function CheckPage() {
  const { projectId } = useWorkspace(),
    { checkId = "" } = useParams();
  const q = useQuery({
    queryKey: ["check", projectId, checkId],
    queryFn: () =>
      integrationRequest<CheckData>(projectId, "checks/" + encodeURIComponent(checkId)),
    refetchInterval: (query) =>
      ["RUNNING", "QUEUED"].includes(query.state.data?.job.status ?? "RUNNING") ? 3000 : false,
  });
  const cancel = useMutation({
    mutationFn: () =>
      integrationRequest(projectId, "checks/" + encodeURIComponent(checkId) + "/cancel", "POST"),
  });
  if (q.isPending) return <Spinner label="Loading check…" />;
  if (q.error || !q.data)
    return (
      <div className="page stack">
        <ErrorMessage error={q.error} />
        <div>
          <button className="btn" onClick={() => void q.refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  const job = q.data.job,
    events = JSON.parse(job.events_json) as { phase: string; status: string; message: string }[];
  const status = checkDisplayStatus(job, q.dataUpdatedAt),
    active = ["RUNNING", "QUEUED"].includes(job.status),
    discoveredNoEntries = events.some((event) => /0 supported entry points/i.test(event.message)),
    failed = status === "FAILED";
  const stages = [
    ...(job.source === "github-pending" ? ["dispatch"] : []),
    ...(job.source === "managed" ? ["checkout"] : []),
    "discovery",
    "install",
    "build",
    "test",
    "complete",
  ].map((name) => {
    let event =
      [...events].reverse().find((e) => e.phase === name) ??
      (name === "complete" && !active
        ? {
            phase: name,
            status: job.status,
            message:
              job.source === "github"
                ? "The runner finished. Open the GitHub logs for full output."
                : "This check has ended.",
          }
        : undefined);
    if (event?.status === "RUNNING" && !["RUNNING", "QUEUED"].includes(status))
      event = {
        ...event,
        status: status === "SUCCEEDED" ? "SKIPPED" : status,
        message:
          status === "STALE"
            ? "No recent update from the runner. The outcome isn’t confirmed."
            : "The check ended before this stage reported back.",
      };
    return { name, event };
  });
  return (
    <div className="page">
      <BackLink to={repositoryPath(projectId)}>
        {q.data.repository?.full_name ?? "Repository"}
      </BackLink>
      <PageHeader
        title="Check"
        description={
          <span className="meta">
            <code>{shortSha(job.commit_sha) ?? "Local"}</code>
            <span>{formatTime(job.updated_at)}</span>
            <span>
              {job.source === "managed"
                ? "Traceyard runner"
                : job.source.startsWith("github")
                  ? "GitHub Actions"
                  : "Local runner"}
            </span>
          </span>
        }
        actions={
          <>
            {active && job.source !== "local" && (
              <button
                className="btn"
                disabled={cancel.isPending || cancel.isSuccess}
                onClick={() => cancel.mutate()}
              >
                {cancel.isSuccess ? "Cancelling…" : "Cancel"}
              </button>
            )}
            {job.github_url && (
              <a className="btn" href={job.github_url} target="_blank" rel="noreferrer">
                GitHub logs
                <Icon name="external" />
              </a>
            )}
          </>
        }
      />
      <div className="stack-lg">
        <div className="status-line">
          <CheckStatus value={status} />
          {status === "STALE" && (
            <button className="btn ghost" disabled={q.isFetching} onClick={() => void q.refetch()}>
              <Icon name="refresh" />
              Refresh
            </button>
          )}
        </div>
        <ErrorMessage error={cancel.error} />
        {discoveredNoEntries && (
          <div className="notice" role="status">
            <strong>No supported entry points were discovered</strong>
            <p>
              Traceyard still ran the selected test directly. That execution is useful for this
              check, but it does not mean the repository has a reusable discovered test path yet.
            </p>
          </div>
        )}
        {failed && (
          <div className="notice danger" role="alert">
            <strong>This check needs investigation</strong>
            <p>
              Review the retained check details in Traceyard first. Provider logs are available as
              a technical fallback.
            </p>
            <Link className="text-link" to={`/investigations?project=${encodeURIComponent(projectId)}`}>
              Start an investigation
            </Link>
          </div>
        )}
        <ol className="stages">
          {stages.map(({ name, event }) => (
            <li
              key={name}
              className={event ? "stage " + event.status.toLowerCase() : "stage pending"}
            >
              <span className="stage-marker">
                <Icon
                  name={
                    !event
                      ? "circle"
                      : event.status === "FAILED"
                        ? "failed"
                        : event.status === "RUNNING"
                          ? "spinner"
                          : event.status === "SUCCEEDED"
                            ? "passed"
                            : "circle"
                  }
                />
              </span>
              <div className="stage-body">
                <strong>{stageLabel(name, event?.message)}</strong>
                <span className="muted">{event?.message ?? "Not reached"}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function EnableGitHubChecks({
  projectId,
  close,
  onReady,
}: {
  projectId: string;
  close: () => void;
  onReady: () => void;
}) {
  const finished = useRef(false);
  const cache = useQueryClient();
  const queryKey = ["ci-setup", projectId];
  const setup = useQuery({
    queryKey,
    queryFn: () => integrationRequest<CISetupResult>(projectId, "repository/setup"),
    refetchOnMount: "always",
    retry: false,
    refetchInterval: (q) =>
      ["PREPARING", "AWAITING_MERGE"].includes(q.state.data?.state ?? "") ? 10000 : false,
  });
  const create = useMutation({
    mutationFn: (previewKey: string) =>
      integrationRequest<CISetupResult>(projectId, "repository/setup", "POST", { previewKey }),
    onSuccess: (result) => {
      cache.setQueryData(queryKey, result);
      if (result.state === "PREPARING") void setup.refetch();
    },
  });
  const ready = setup.data?.state === "READY";
  useEffect(() => {
    if (ready && !setup.isFetching && !setup.error && !finished.current) {
      finished.current = true;
      onReady();
    }
  }, [ready, setup.isFetching, setup.error, onReady]);

  const preview = setup.data?.state === "SETUP_REQUIRED" ? setup.data : null;
  const prUrl = setup.data?.state === "AWAITING_MERGE" ? setup.data.prUrl : undefined;
  return (
    <Modal
      title="Run tests in GitHub Actions"
      close={close}
      wide={!!preview}
      footer={
        <>
          <button className="btn" onClick={close}>
            Close
          </button>
          {(setup.error || create.error || prUrl) && (
            <button
              className="btn"
              disabled={setup.isFetching || create.isPending}
              onClick={() => {
                create.reset();
                void setup.refetch();
              }}
            >
              {prUrl ? "Check again" : "Reload preview"}
            </button>
          )}
          {prUrl && (
            <a className="btn primary" href={prUrl} target="_blank" rel="noreferrer">
              Open pull request
              <Icon name="external" />
            </a>
          )}
          {preview?.previewKey && (
            <button
              className="btn primary"
              disabled={setup.isFetching || create.isPending || !!create.error}
              onClick={() => create.mutate(preview.previewKey!)}
            >
              {create.isPending ? "Opening pull request…" : "Open pull request"}
            </button>
          )}
        </>
      }
    >
      {setup.isPending && <Spinner label="Loading the workflow preview…" />}
      {setup.data?.state === "PREPARING" && <Spinner label="Preparing the pull request…" />}
      {ready && <p role="status">The workflow is ready.</p>}
      {preview && (
        <>
          <p>
            Traceyard opens a pull request that adds <code>.github/workflows/traceyard.yml</code>.
            Merge it into <code>{preview.defaultBranch}</code> to run tests from here.
          </p>
          {preview.previousWorkflow != null && (
            <details className="disclosure">
              <summary>
                <Icon name="chevron-right" />
                Current workflow on {preview.defaultBranch}
              </summary>
              <pre className="code">{preview.previousWorkflow}</pre>
            </details>
          )}
          <pre className="code">{preview.workflow}</pre>
        </>
      )}
      {prUrl && (
        <p role="status">
          The pull request is open. Merge it on GitHub, then come back here. This page checks every
          few seconds.
        </p>
      )}
      <ErrorMessage error={setup.error || create.error} />
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
  const [directory, setDirectory] = useState(config.directory === "." ? "" : config.directory),
    cache = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      integrationRequest(projectId, "runner-config", "PUT", {
        ...config,
        directory: directory.trim().replace(/^\.\/|\/$/g, "") || ".",
      }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["catalog", projectId] });
      close();
    },
  });
  return (
    <Modal
      title="Test settings"
      close={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" form="test-settings" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form
        id="test-settings"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className="field">
          <span className="field-label">App folder (optional)</span>
          <input
            className="mono"
            value={directory}
            placeholder="apps/web"
            spellCheck={false}
            onChange={(e) => setDirectory(e.target.value)}
          />
          <span className="field-hint">
            The folder that holds package.json. Leave blank if it’s at the top of the repository.
          </span>
        </label>
        <ErrorMessage error={save.error} />
      </form>
    </Modal>
  );
}

export function ConnectRepository({
  projectId,
  close,
  connected,
}: {
  /** Attach the repository to this existing project instead of creating one. */
  projectId?: string;
  close: () => void;
  connected: () => void;
}) {
  const { session } = useWorkspace(),
    cache = useQueryClient(),
    navigate = useNavigate();
  const q = useQuery({
    queryKey: ["github-repositories", session.user!.id],
    queryFn: () => request<RepositoryChoices>("/api/repositories"),
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    staleTime: 0,
  });
  const connect = useMutation({
    mutationFn: async (r: RepositoryChoice) => {
      if (projectId) {
        await integrationRequest(projectId, "repository", "POST", {
          repositoryId: r.id,
          installationId: r.installationId,
        });
        const project = cache
          .getQueryData<ProjectSummary[]>(["projects", session.user!.id])
          ?.find((p) => p.id === projectId);
        if (!project) throw Error("This project is no longer available.");
        return project;
      }
      const response = await fetch("/api/repositories/connect", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryId: r.id, installationId: r.installationId }),
      });
      const body = (await response.json()) as {
        data?: { project: ProjectSummary };
        error?: { message: string };
      };
      if (!response.ok || !body.data)
        throw Error(body.error?.message ?? "The repository could not be connected.");
      return body.data.project;
    },
    onSuccess: (project) => {
      void cache.invalidateQueries({ queryKey: ["workspace-projects"] });
      void cache.invalidateQueries({ queryKey: ["projects"] });
      cache.setQueryData<ProjectSummary[]>(["projects", session.user!.id], (old) => [
        ...(old ?? []).filter((p) => p.id !== project.id),
        project,
      ]);
      savePreference("project:" + session.user!.id, project.id);
      navigate("/investigations?project=" + encodeURIComponent(project.id));
      connected();
    },
  });
  return (
    <Modal title="Connect a repository" close={close}>
      <RepositoryPicker
        data={q.data}
        loading={q.isPending}
        refreshing={q.isFetching}
        error={q.error || connect.error}
        connectingId={connect.isPending ? connect.variables?.id : undefined}
        onConnect={(repo) => connect.mutate(repo)}
        onRefresh={() => {
          connect.reset();
          void q.refetch();
        }}
      />
    </Modal>
  );
}

export function RepositorySetup() {
  return (
    <div className="page prose">
      <BackLink to="/repositories">Repositories</BackLink>
      <PageHeader
        title="GitHub App setup"
        description="One-time configuration for whoever hosts this Traceyard server."
      />
      <section className="stack">
        <h2 className="section-title">1. Register a GitHub App</h2>
        <p>
          Use a public HTTPS deployment. GitHub can’t reach localhost. Set the webhook URL to{" "}
          <code>https://YOUR_TRACEYARD_HOST/api/github/webhook</code> and subscribe to push and
          workflow run events.
        </p>
        <p>
          Repository permissions: <strong>Contents</strong>, <strong>Pull requests</strong>,{" "}
          <strong>Workflows</strong> and <strong>Actions</strong> read and write, plus{" "}
          <strong>Metadata</strong> read. Traceyard only writes{" "}
          <code>.github/workflows/traceyard.yml</code>, through a pull request you approve.
        </p>
        <h2 className="section-title">2. Add the secrets</h2>
        <pre className="code">{`PUBLIC_APP_ORIGIN=https://YOUR_TRACEYARD_HOST
GITHUB_APP_ID=<GitHub App ID>
GITHUB_APP_SLUG=<GitHub App slug>
GITHUB_APP_PRIVATE_KEY=<PKCS#8 RSA private key>
GITHUB_APP_WEBHOOK_SECRET=<webhook secret>`}</pre>
        <p className="muted">
          Keep them in your deployment’s secret store. The GitHub App is separate from the OAuth app
          used for sign-in.
        </p>
        <h2 className="section-title">3. Connect a repository</h2>
        <p>
          Install the app on the repositories you want, then choose{" "}
          <strong>Connect repository</strong> in Traceyard. Full details are in{" "}
          <code>docs/REPOSITORY_SETUP.md</code>.
        </p>
      </section>
    </div>
  );
}
