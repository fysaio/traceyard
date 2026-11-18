import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ProjectLink as Link } from "../components/project-link";
import { Modal, Icon, ErrorMessage } from "../components/product-ui";
import {
  RepositoryPicker,
  type RepositoryChoice,
  type RepositoryChoices,
} from "../components/repository-picker";
import { integrationRequest, integrations } from "../lib/integrations-api";
import type { ProjectSummary } from "../lib/api";
import { useWorkspace, savePreference } from "../lib/workspace";
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
export function ConnectRepository({
  projectId,
  attachToProject = false,
  mode,
  close,
  connected,
  destination,
}: {
  projectId?: string;
  attachToProject?: boolean;
  mode: "github" | "local";
  close: () => void;
  connected: () => void;
  destination?: "investigate";
}) {
  const [local, setLocal] = useState(mode === "local");
  const { session } = useWorkspace(),
    cache = useQueryClient(),
    navigate = useNavigate();
  const q = useQuery({
    queryKey: ["github-repositories", session.user!.id],
    queryFn: async () => {
      const r = await fetch("/api/repositories", { credentials: "same-origin" });
      const body = (await r.json()) as {
        data: RepositoryChoices;
        error?: { message: string };
      };
      if (!r.ok) throw Error(body.error?.message ?? "Repositories could not be loaded.");
      return body.data;
    },
    enabled: !local,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    staleTime: 0,
  });
  const connect = useMutation({
    mutationFn: async (r: RepositoryChoice) => {
      if (attachToProject && projectId) {
        await integrationRequest(projectId, "repository", "POST", {
          repositoryId: r.id,
          installationId: r.installationId,
        });
        const project = cache
          .getQueryData<ProjectSummary[]>(["projects", session.user!.id])
          ?.find((p) => p.id === projectId);
        if (!project) throw Error("Project is no longer available.");
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
        throw Error(body.error?.message ?? "Repository could not be connected.");
      return body.data.project;
    },
    onSuccess: (project) => {
      void cache.invalidateQueries({ queryKey: ["workspace-projects"] });
      cache.setQueryData<ProjectSummary[]>(["projects", session.user!.id], (old) => [
        ...(old ?? []).filter((p) => p.id !== project.id),
        project,
      ]);
      savePreference("project:" + session.user!.id, project.id);
      navigate(
        destination === "investigate"
          ? "/investigations?project=" + encodeURIComponent(project.id)
          : "/projects/" + encodeURIComponent(project.id),
      );
      connected();
    },
  });
  const [copied, setCopied] = useState(false);
  const env = "TRACEYARD_ORIGIN=" + window.location.origin + "\nTRACEYARD_KEY=<your project key>\n";
  return (
    <Modal
      title={local ? "Connect your local project" : "Connect a repo"}
      close={close}
      className={local ? "" : "repository-dialog"}
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
          <pre className="code">node /path/to/traceyard/agent/cli.mjs run .</pre>
          <p className="hint">
            One command connects this directory, scans its source, installs locked dependencies and
            runs existing npm build/tests with supported Node recording. Results appear in this
            project as it works. Each command stops after 180 seconds; no server is kept running
            afterward. A package-lock.json is required. Remote Deno/Supabase execution needs its own
            runtime integration.
          </p>
        </>
      ) : (
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
          onLocal={() => setLocal(true)}
        />
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
          Repository permissions: Contents and Metadata — read-only. Subscribe to Push events.
          Legacy GitHub Actions checks can also use Actions read permission. This version supports
          personal GitHub installations.
        </p>
        <h3 className="section">Deployment environment</h3>
        <pre className="code">{`PUBLIC_APP_ORIGIN=https://YOUR_TRACEYARD_HOST
GITHUB_APP_ID=<GitHub App ID>
GITHUB_APP_SLUG=<GitHub App slug>
GITHUB_APP_PRIVATE_KEY=<PKCS#8 RSA private key, stored as a secret>
GITHUB_APP_WEBHOOK_SECRET=<matching webhook secret>
`}</pre>
        <p className="section">
          Keep these values in the deployment’s secret store. The GitHub App is separate from the
          OAuth app used for sign-in. Apply migrations through 0013 and deploy the standard Worker
          configuration for free hosting. Repository checks can run locally and send results here;
          hosted execution is an optional separate deployment.
        </p>
        <h3 className="section">Then connect a repository</h3>
        <p>
          Install the app on selected personal repositories, return to Project, choose Connect repo
          and refresh the list. Existing personal installations are detected automatically.
          Discovery starts in the background. Choose Run locally to record checks from your
          computer. No setup PR is required.
        </p>
        <p className="hint section">
          Detailed setup, permissions, supported runtimes and limits are in docs/REPOSITORY_SETUP.md
          in the same checkout.
        </p>
      </section>
    </>
  );
}
