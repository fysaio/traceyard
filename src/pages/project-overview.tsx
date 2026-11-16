import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ProjectLink as Link } from "../components/project-link";
import { Modal, Icon, ErrorMessage } from "../components/product-ui";
import { integrationRequest, integrations } from "../lib/integrations-api";
import { useWorkspace } from "../lib/workspace";
import type { RepositoryRecord, RepositoryJob } from "../../shared/repository/contracts";
import type { DiscoveredOperation } from "../../agent/discovery.mjs";
type Activity = {
  id: string;
  name: string;
  source: "application" | "managed";
  status: string;
  startedAt: string;
  endedAt: string | null;
  steps?: number;
};
const time = (start: string, end: string | null) =>
  end ? Math.max(0, Date.parse(end) - Date.parse(start)) + " ms" : "In progress";
function Status({ value }: { value: string }) {
  return (
    <span className={"activity-status " + value.toLowerCase()}>
      <Icon
        name={
          value === "FAILED"
            ? "circle-xmark"
            : value === "SUCCEEDED"
              ? "circle-check"
              : value === "RUNNING"
                ? "circle-notch"
                : "circle"
        }
      />
      {value === "SUCCEEDED"
        ? "Completed"
        : value === "SKIPPED"
          ? "Not tested"
          : value.toLowerCase()}
    </span>
  );
}
interface RepositoryData {
  repository: RepositoryRecord | null;
  jobs: RepositoryJob[];
}
export function ProjectOverview({ projectId }: { projectId: string }) {
  const { projects } = useWorkspace(),
    cache = useQueryClient();
  const [connect, setConnect] = useState<"github" | "local" | null>(null),
    [operation, setOperation] = useState<DiscoveredOperation | null>(null),
    [notice, setNotice] = useState(""),
    [selectedCheck, setSelectedCheck] = useState("");
  const repo = useQuery({
    queryKey: ["repository", projectId],
    queryFn: () => integrationRequest<RepositoryData>(projectId, "repository"),
    refetchInterval: 3000,
  });
  const recorded = useQuery({
    queryKey: ["activity", projectId],
    queryFn: () => integrationRequest<{ items: Activity[] }>(projectId, "activity"),
    refetchInterval: 3000,
  });
  const hasRecording = !!recorded.data?.items.some((item) => item.source === "application");
  const r = repo.data?.repository;
  const scan = r?.scan_json
    ? (JSON.parse(r.scan_json) as {
        operations: DiscoveredOperation[];
        filesScanned: number;
        warnings: string[];
      })
    : null;
  const refresh = () => cache.invalidateQueries({ queryKey: ["repository", projectId] });
  const action = useMutation({
    mutationFn: (kind: "scan" | "setup" | "run") =>
      integrationRequest<{ url?: string }>(projectId, "repository/" + kind, "POST"),
    onSuccess: (result) => {
      setNotice(
        result.url
          ? "Request sent. Follow the GitHub link below for progress."
          : "Discovery started.",
      );
      void refresh();
    },
  });
  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">
            {r?.repository_id ? "GitHub repository" : r ? "Local project" : "Your application"}
          </p>
          <h1>{r?.full_name ?? projects.find((p) => p.id === projectId)?.name ?? "Project"}</h1>
          <p>Understand what runs. Find the failure. Check the fix.</p>
        </div>
        <div className="actions">
          {r?.repository_id ? (
            <>
              <button
                className="btn"
                disabled={action.isPending || r.status === "DISCOVERING"}
                onClick={() => action.mutate("scan")}
              >
                <Icon name="rotate" />
                Scan changes
              </button>
              <button
                className="btn primary"
                disabled={action.isPending}
                onClick={() => action.mutate(r.runner_enabled ? "run" : "setup")}
              >
                {r.runner_enabled
                  ? "Run project tests"
                  : r.setup_pr_url
                    ? "Open installation PR"
                    : "Set up project tests"}
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setConnect("github")}>
              <i className="fa-brands fa-github" aria-hidden="true" />
              Connect repository
            </button>
          )}
        </div>
      </div>
      <ErrorMessage error={repo.error || action.error} />
      {notice && <p role="status">{notice}</p>}
      {action.data?.url && (
        <a className="btn section" href={action.data.url} target="_blank" rel="noreferrer">
          Open GitHub progress <Icon name="arrow-up-right-from-square" />
        </a>
      )}
      {!r && !repo.isPending && !hasRecording && (
        <section className="project-onboarding">
          <div className="workflow-icon">
            <i className="fa-brands fa-github" aria-hidden="true" />
          </div>
          <div>
            <h2>
              {hasRecording ? "Your application is recording." : "Start with your existing code."}
            </h2>
            <p>
              {hasRecording
                ? "Connect its source to discover supported entry points and set up project checks. Your recorded runs are already available below."
                : "Select a repository. Traceyard finds supported entry points, then guides you through running your project’s checks."}
            </p>
            <div className="actions section">
              <button className="btn primary" onClick={() => setConnect("github")}>
                Connect GitHub repository <Icon name="arrow-right" />
              </button>
              <button className="btn" onClick={() => setConnect("local")}>
                Connect a local project
              </button>
            </div>
          </div>
        </section>
      )}
      {r?.status === "DISCOVERING" && (
        <section className="project-progress" role="status">
          <Icon name="circle-notch" />
          <div>
            <h2>Reading your repository</h2>
            <p>
              Finding supported routes and jobs. Results appear here as soon as discovery completes.
            </p>
          </div>
        </section>
      )}
      {r?.setup_pr_url && !r.runner_enabled && (
        <p className="hint section">
          Merge the{" "}
          <a className="text-link" target="_blank" rel="noreferrer" href={r.setup_pr_url}>
            installation pull request
          </a>{" "}
          to start the first GitHub check. Code discovery works before runtime recording is
          installed.
        </p>
      )}
      {r?.last_error && (
        <p className="request-error" role="alert">
          {r.last_error}
        </p>
      )}
      {scan && (
        <section className="section">
          <div className="section-head">
            <div>
              <h2>Discovered operations</h2>
              <p className="hint">
                {scan.filesScanned} files scanned · Source discovery shows possible paths. Runs
                below show what actually happened.
              </p>
            </div>
            {r?.commit_sha && <span className="quiet-meta">Commit {r.commit_sha.slice(0, 7)}</span>}
          </div>
          <div className="operation-grid">
            {scan.operations.map((o) => (
              <button className="operation-card" key={o.id} onClick={() => setOperation(o)}>
                <span className="node-type">
                  {o.kind === "http" ? "HTTP entry point" : "Background job"}
                </span>
                <strong>{o.name}</strong>
                <span className="quiet-meta">
                  {o.file}:{o.line}
                </span>
                <span className="text-link">
                  Inspect source <Icon name="arrow-right" />
                </span>
              </button>
            ))}
          </div>
          {!scan.operations.length && (
            <p className="connected-panel">
              No supported entry points found. This scanner recognises conventional
              Express/Hono/Fastify routes, Next.js API handlers, Deno.serve and selected job
              declarations. Existing recorded runs remain available below.
            </p>
          )}
          {scan.warnings.map((warning, i) => (
            <p key={i} className="hint section">
              {warning}
            </p>
          ))}
        </section>
      )}
      {!!repo.data?.jobs.length && (
        <section className="section">
          <h2>Project checks</h2>
          <p className="hint">
            Build and test results for a specific code version. These are separate from requests
            made by your application.
          </p>
          <div className="check-runs">
            {repo.data.jobs.map((job) => (
              <CheckRun
                key={job.id}
                job={job}
                inspect={() => {
                  setSelectedCheck(job.id);
                  document.getElementById("project-activity")?.scrollIntoView({ block: "start" });
                }}
              />
            ))}
          </div>
        </section>
      )}
      <ProjectActivity
        key={selectedCheck || "all"}
        projectId={projectId}
        checkRun={selectedCheck}
        clearCheck={() => setSelectedCheck("")}
      />
      <div className="project-secondary">
        <Link className="text-link" to="/builder">
          Build a workflow inside Traceyard <Icon name="arrow-right" />
        </Link>
        {(!r || !r.repository_id) && (
          <button className="text-link" onClick={() => setConnect("local")}>
            Local setup instructions
          </button>
        )}
        <Link className="text-link" to="/settings/developer">
          API keys & connection settings
        </Link>
      </div>
      {connect && (
        <ConnectRepository
          projectId={projectId}
          mode={connect}
          close={() => setConnect(null)}
          connected={() => {
            setConnect(null);
            void refresh();
          }}
        />
      )}
      {operation && (
        <Modal title={operation.name} close={() => setOperation(null)}>
          <p className="hint">Discovered in source. This is not a record of an execution.</p>
          <p className="section">
            <strong>
              {operation.file}:{operation.line}
            </strong>
          </p>
          {r?.repository_id && r.commit_sha && (
            <a
              className="btn section"
              target="_blank"
              rel="noreferrer"
              href={
                "https://github.com/" +
                r.full_name +
                "/blob/" +
                r.commit_sha +
                "/" +
                operation.file.split("/").map(encodeURIComponent).join("/") +
                "#L" +
                operation.line
              }
            >
              Open this code version <Icon name="arrow-up-right-from-square" />
            </a>
          )}
          <h3 className="section">Direct calls found in this handler</h3>
          {operation.calls.length ? (
            <ul className="source-calls">
              {operation.calls.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          ) : (
            <p className="hint">
              No direct calls resolved. Imported or dynamic relationships may need runtime evidence.
            </p>
          )}
          <p className="hint section">
            Project tests exercise the configured test suite. Individual operation tests require a
            test case that reaches this handler.
          </p>
        </Modal>
      )}
    </>
  );
}
function CheckRun({ job, inspect }: { job: RepositoryJob; inspect: () => void }) {
  const events = JSON.parse(job.events_json) as {
    phase: string;
    status: string;
    message: string;
    at: string;
  }[];
  return (
    <article className="check-run">
      <div className="section-head">
        <div>
          <h3>
            {job.source === "github" ? "GitHub checks" : "Local checks"} ·{" "}
            {job.commit_sha?.slice(0, 7) ?? "Uncommitted directory"}
          </h3>
          <p className="hint">{new Date(job.updated_at).toLocaleString()}</p>
        </div>
        <Status value={job.status} />
      </div>
      <ol className="check-events">
        {events.map((e, i) => (
          <li key={i}>
            <Status value={e.status} />
            <div>
              <strong>{e.phase}</strong>
              <p>{e.message}</p>
            </div>
          </li>
        ))}
      </ol>
      <button className="btn section" onClick={inspect}>
        View recorded application runs <Icon name="arrow-right" />
      </button>
      {job.github_url && (
        <a className="text-link" href={job.github_url} target="_blank" rel="noreferrer">
          Build logs and progress on GitHub <Icon name="arrow-up-right-from-square" />
        </a>
      )}
    </article>
  );
}
export function ProjectActivity({
  projectId,
  checkRun = "",
  clearCheck,
}: {
  projectId: string;
  checkRun?: string;
  clearCheck?: () => void;
}) {
  const [params] = useSearchParams(),
    [selected, setSelected] = useState(params.get("trace") ?? ""),
    [span, setSpan] = useState(""),
    [filter, setFilter] = useState("all"),
    [operationName, setOperationName] = useState("");
  const q = useQuery({
    queryKey: checkRun ? ["activity", projectId, checkRun] : ["activity", projectId],
    queryFn: () =>
      integrationRequest<{ items: Activity[] }>(
        projectId,
        "activity" + (checkRun ? "?checkRun=" + encodeURIComponent(checkRun) : ""),
      ),
    refetchInterval: 3000,
  });
  const detail = useQuery({
    queryKey: ["spans", projectId, selected],
    queryFn: () => integrations.spans(projectId, selected),
    enabled: !!selected,
    refetchInterval: 3000,
  });
  const items = q.data?.items ?? [],
    filtered = items.filter((i) => filter === "all" || i.status === "FAILED"),
    rows = filtered.filter((i) => !operationName || i.name === operationName),
    grouped = Array.from(new Set(filtered.map((i) => i.name))).map((name) => ({
      name,
      runs: filtered.filter((i) => i.name === name),
    }));
  const active = detail.data?.items.find((s) => s.span_id === span);
  return (
    <section className="section" id="project-activity">
      <div className="section-head">
        <div>
          <h2>Operations and runs</h2>
          <p className="hint">Choose an operation, then a run to inspect what happened.</p>
        </div>
        <div className="segmented" role="group" aria-label="Filter application runs">
          <button
            aria-pressed={filter === "all"}
            className={filter === "all" ? "selected" : ""}
            onClick={() => {
              setFilter("all");
              setOperationName("");
              setSelected("");
              setSpan("");
            }}
          >
            All runs <span>{items.length}</span>
          </button>
          <button
            aria-pressed={filter === "failed"}
            className={filter === "failed" ? "selected" : ""}
            onClick={() => {
              setFilter("failed");
              setOperationName("");
              setSelected("");
              setSpan("");
            }}
          >
            Failed <span>{items.filter((i) => i.status === "FAILED").length}</span>
          </button>
        </div>
      </div>
      {checkRun && (
        <div className="section-head section">
          <p className="hint">Application runs recorded during check {checkRun}.</p>
          <button className="btn" onClick={clearCheck}>
            Show all application runs
          </button>
        </div>
      )}
      <ErrorMessage error={q.error} />
      {!!items.length && (
        <div className="observed-operations" role="group" aria-label="Observed operations">
          <button
            aria-pressed={!operationName}
            className={operationName ? "" : "selected"}
            onClick={() => {
              setOperationName("");
              setSelected("");
            }}
          >
            All operations
          </button>
          {grouped.map((group) => (
            <button
              aria-pressed={operationName === group.name}
              className={operationName === group.name ? "selected" : ""}
              key={group.name}
              onClick={() => {
                setOperationName(group.name);
                setSelected("");
                setSpan("");
              }}
            >
              <strong>{group.name}</strong>
              <span>
                {group.runs.length} {filter === "failed" ? "failed" : "recent"} runs
              </span>
              {group.runs.some((r) => r.status === "FAILED") && (
                <span className="activity-status failed">
                  {group.runs.filter((r) => r.status === "FAILED").length} failed
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {q.isPending ? (
        <p role="status">Loading recorded runs…</p>
      ) : !items.length ? (
        <div className="activity-empty">
          <h3>No application runs received yet</h3>
          <p>
            Use your application normally after enabling recording. Source discovery and a passing
            build do not create application traffic.
          </p>
          <Link className="btn section" to="/connect">
            Enable runtime recording <Icon name="arrow-right" />
          </Link>
        </div>
      ) : !rows.length ? (
        <p className="activity-empty">
          No failed runs in the latest {items.length} recorded executions.
        </p>
      ) : (
        <div className={"activity-layout " + (selected ? "has-detail" : "")}>
          <div className="activity-list">
            {rows.map((item) =>
              item.source === "managed" ? (
                <Link key={item.id} className="activity-row" to={"/executions/" + item.id}>
                  <strong>{item.name}</strong>
                  <Status value={item.status} />
                  <span className="quiet-meta">
                    {new Date(item.startedAt).toLocaleString()} · Traceyard workflow
                  </span>
                </Link>
              ) : (
                <button
                  key={item.id}
                  className={"activity-row " + (selected === item.id ? "selected" : "")}
                  onClick={() => {
                    setSelected(item.id);
                    setSpan("");
                  }}
                >
                  <strong>{item.name}</strong>
                  <Status value={item.status} />
                  <span className="quiet-meta">
                    {new Date(item.startedAt).toLocaleString()} · {item.steps} recorded steps ·{" "}
                    {time(item.startedAt, item.endedAt)}
                  </span>
                </button>
              ),
            )}
          </div>
          {selected && (
            <aside className="activity-detail">
              <div className="section-head">
                <h3>Recorded steps</h3>
                <button
                  className="btn icon-only"
                  aria-label="Close run detail"
                  onClick={() => {
                    setSelected("");
                    setSpan("");
                  }}
                >
                  <Icon name="xmark" />
                </button>
              </div>
              <ErrorMessage error={detail.error} />
              {detail.isPending && <p role="status">Loading steps…</p>}
              <p className="hint">
                Completed means the code reported completion. Output quality needs a separate test.
              </p>
              <div className="recorded-steps">
                {detail.data?.items.map((s) => (
                  <button
                    key={s.span_id}
                    className={"recorded-step " + (span === s.span_id ? "selected" : "")}
                    onClick={() => setSpan(s.span_id)}
                  >
                    <strong>
                      {s.parent_span_id ? "↳ " : ""}
                      {s.name}
                    </strong>
                    <Status value={s.status} />
                    <span className="quiet-meta">{time(s.started_at, s.ended_at)}</span>
                  </button>
                ))}
              </div>
              {active && (
                <div className="recorded-payload">
                  <h3>{active.name}</h3>
                  {(["attributes_json", "input_json", "output_json", "error_json"] as const).map(
                    (key) =>
                      active[key] && (
                        <section className="section" key={key}>
                          <h4>{key.replace("_json", "")}</h4>
                          <pre className="code">
                            {JSON.stringify(JSON.parse(active[key]!), null, 2)}
                          </pre>
                        </section>
                      ),
                  )}
                </div>
              )}
            </aside>
          )}
        </div>
      )}
      {items.length > 0 && (
        <p className="hint section">
          Showing the latest {items.length} runs, up to 100. Steps appear only where recording is
          enabled.
        </p>
      )}
    </section>
  );
}
function ConnectRepository({
  projectId,
  mode,
  close,
  connected,
}: {
  projectId: string;
  mode: "github" | "local";
  close: () => void;
  connected: () => void;
}) {
  const [local, setLocal] = useState(mode === "local");
  const q = useQuery({
    queryKey: ["github-repositories"],
    queryFn: async () => {
      const r = await fetch("/api/repositories");
      const body = (await r.json()) as {
        data: {
          configured: boolean;
          installUrl: string | null;
          items: { id: number; name: string; installationId: number }[];
        };
        error?: { message: string };
      };
      if (!r.ok) throw Error(body.error?.message ?? "Repositories could not be loaded.");
      return body.data;
    },
    enabled: !local,
  });
  const connect = useMutation({
    mutationFn: (r: { id: number; installationId: number }) =>
      integrationRequest(projectId, "repository", "POST", {
        repositoryId: r.id,
        installationId: r.installationId,
      }),
    onSuccess: connected,
  });
  const [copied, setCopied] = useState(false);
  const env = "TRACEYARD_ORIGIN=" + window.location.origin + "\nTRACEYARD_KEY=<your project key>\n";
  return (
    <Modal
      title={local ? "Connect your local project" : "Connect a GitHub repository"}
      close={close}
    >
      {local ? (
        <>
          <p>
            Create <strong>.env.traceyard</strong> in your application folder and add that filename
            to .gitignore.
          </p>
          <pre className="code section">{env}</pre>
          <button
            className="btn"
            onClick={() => void navigator.clipboard.writeText(env).then(() => setCopied(true))}
          >
            {copied ? "Copied placeholders" : "Copy environment template"}
          </button>
          <p className="section">
            Create a key with <strong>traces:write</strong> under{" "}
            <Link className="text-link" to="/settings/developer" onClick={close}>
              API keys & SDK
            </Link>
            , then replace the placeholder locally.
          </p>
          <p className="section">
            With Node.js 22.12+, run this from your application folder using your Traceyard
            checkout:
          </p>
          <pre className="code">node /path/to/traceyard/agent/cli.mjs connect .</pre>
          <p className="hint">
            The command reads .env.traceyard, scans supported source files and uploads an index.
            Source contents and environment files are excluded.
          </p>
          <p className="section">
            To run its existing npm build and tests with supported Node.js recording:
          </p>
          <pre className="code">node /path/to/traceyard/agent/cli.mjs run .</pre>
          <p className="hint">
            Run executes the project’s npm install/build/test scripts. A package-lock.json is
            required. Hosted backends such as Supabase Edge Functions need their own runtime
            integration.
          </p>
        </>
      ) : (
        <>
          <p>Choose a repository already installed on your personal GitHub account.</p>
          <ErrorMessage error={q.error || connect.error} />
          {q.isPending ? (
            <p role="status">Loading repositories…</p>
          ) : q.data?.configured ? (
            <>
              <div className="repository-choices section">
                {q.data.items.map((r) => (
                  <button
                    key={r.id}
                    className="repository-choice"
                    disabled={connect.isPending}
                    onClick={() => connect.mutate(r)}
                  >
                    <i className="fa-brands fa-github" aria-hidden="true" />
                    <strong>{r.name}</strong>
                    <Icon name="arrow-right" />
                  </button>
                ))}
              </div>
              {!q.data.items.length && (
                <p className="section">
                  No repositories available. Install Traceyard below, select a personal repository,
                  then refresh.
                </p>
              )}
              {q.data.installUrl && (
                <a
                  className="btn primary section"
                  href={q.data.installUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Install Traceyard on GitHub
                </a>
              )}
              <button className="btn section" onClick={() => void q.refetch()}>
                Refresh repositories
              </button>
            </>
          ) : (
            <div className="activity-empty section">
              <h3>GitHub connection needs server setup</h3>
              <p>
                The Traceyard deployment needs its GitHub App credentials, signed webhook and pinned
                runner version before repositories can be listed.
              </p>
              <a className="text-link" href="/repository-setup">
                Deployment setup instructions <Icon name="arrow-up-right-from-square" />
              </a>
            </div>
          )}
          <button className="text-link section" onClick={() => setLocal(true)}>
            Connect a local project instead
          </button>
        </>
      )}
    </Modal>
  );
}

export function RepositorySetup() {
  return (
    <>
      <Link className="back" to="/">
        ← Project
      </Link>
      <div className="page-head">
        <div>
          <h1>GitHub connection setup</h1>
          <p>One-time configuration for the person hosting this Traceyard server.</p>
        </div>
      </div>
      <section className="connected-panel">
        <h2>Register the Traceyard GitHub App</h2>
        <p className="section">
          Use a public HTTPS deployment. GitHub cannot deliver webhooks or runner results to
          localhost. Set the app webhook to{" "}
          <code>https://YOUR_TRACEYARD_HOST/api/github/webhook</code>.
        </p>
        <p className="section">
          Repository permissions: Contents, Pull requests, Workflows and Actions — read/write.
          Metadata is read-only. Subscribe to Installation and Workflow run events. This version
          supports personal GitHub installations.
        </p>
        <h3 className="section">Deployment environment</h3>
        <pre className="code">{`PUBLIC_APP_ORIGIN=https://YOUR_TRACEYARD_HOST
GITHUB_APP_ID=<GitHub App ID>
GITHUB_APP_SLUG=<GitHub App slug>
GITHUB_APP_PRIVATE_KEY=<PKCS#8 RSA private key, stored as a secret>
GITHUB_APP_WEBHOOK_SECRET=<matching webhook secret>
TRACEYARD_RUNNER_REF=<40-character commit containing the runner>`}</pre>
        <p className="section">
          Keep these values in the deployment’s secret store. The GitHub App is separate from the
          OAuth app used for sign-in. Apply migration 0008 and deploy the
          RepositoryDiscoveryWorkflow binding.
        </p>
        <h3 className="section">Then connect a repository</h3>
        <p>
          Install the app on selected personal repositories, return to Project, choose Connect
          repository and refresh the list. Discovery starts in the background. Set up project tests
          creates a reviewable installation PR; merging it starts GitHub-hosted checks.
        </p>
        <p className="hint section">
          Detailed setup, permissions, supported runtimes and limits are in docs/REPOSITORY_SETUP.md
          in the same checkout.
        </p>
      </section>
    </>
  );
}
