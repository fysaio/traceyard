import { ProjectLink as Link } from "../components/project-link";
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { studioApi } from "../lib/studio-api";
import { Icon, ErrorMessage } from "../components/product-ui";
import { WorkflowDiagram } from "./workflow-library";
import { Launch } from "../App";
export function WorkflowDetail({ projectId }: { projectId: string }) {
  const { id = "" } = useParams(),
    [params] = useSearchParams(),
    version = Number(params.get("version")) || undefined,
    [tab, setTab] = useState("overview"),
    [launch, setLaunch] = useState(false);
  const q = useQuery({
      queryKey: ["workflow", id, projectId, version],
      queryFn: () => api.workflow(id, projectId, version),
    }),
    versions = useQuery({
      queryKey: ["studio", projectId, id],
      queryFn: () => studioApi.get(projectId, id),
      enabled: !!q.data?.graph,
    }),
    runs = useQuery({
      queryKey: ["workflow-runs", projectId, id],
      queryFn: () => api.runs({ projectId, workflowId: id, limit: 100 }),
      enabled: tab === "runs",
    });
  if (q.isPending)
    return (
      <p className="loading-state" role="status">
        Loading workflow…
      </p>
    );
  if (q.isError) return <ErrorMessage error={q.error} />;
  const w = q.data;
  return (
    <>
      <Link className="back" to="/builder">
        <Icon name="arrow-left" /> Build
      </Link>
      <div className="page-head">
        <div>
          <h1>{w.name}</h1>
          <p>{w.description}</p>
        </div>
        <div className="actions">
          {w.graph && (
            <Link className="btn" to={"/studio/" + id}>
              Edit in Studio
            </Link>
          )}
          <button className="btn primary" onClick={() => setLaunch(true)}>
            <Icon name="play" />
            Run workflow
          </button>
        </div>
      </div>
      <div className="quiet-meta">
        <span>Version {w.version}</span>
        <span>{w.steps.length} steps</span>
        <span>Cloudflare Workflows</span>
      </div>
      <div className="section">
        {w.graph ? (
          <WorkflowDiagram graph={w.graph} />
        ) : (
          <div className="readable-graph" aria-label="Document pipeline steps">
            {w.steps.map((s) => (
              <article className="readable-node" key={s.key}>
                <span className="node-type">
                  <Icon name="cube" />
                  step {s.ordinal}
                </span>
                <strong>{s.name}</strong>
                <p>{s.description}</p>
              </article>
            ))}
          </div>
        )}
      </div>
      <div className="product-tabs section" role="tablist">
        {["overview", "runs", "versions", "settings"].map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "overview" ? (
        <div className="integration-columns">
          <section className="connected-panel">
            <h2>What goes in</h2>
            {w.graph ? (
              <pre className="code">
                {JSON.stringify(
                  w.graph.nodes.find((n) => n.type === "input")?.config.value ?? {},
                  null,
                  2,
                )}
              </pre>
            ) : (
              <p>
                A title and document text. The pipeline extracts structured fields and records its
                result.
              </p>
            )}
          </section>
          <section className="connected-panel">
            <h2>What comes out</h2>
            <p>The output of the final step, with its execution history and retained payloads.</p>
            <div className="actions section">
              <Link className="btn" to="/laboratory">
                Test this workflow
              </Link>
              <Link className="btn" to="/traces">
                Inspect traces
              </Link>
            </div>
          </section>
        </div>
      ) : tab === "runs" ? (
        <section className="connected-panel">
          <h2>Executions</h2>
          {runs.isPending ? (
            <p role="status">Loading executions…</p>
          ) : runs.isError ? (
            <ErrorMessage error={runs.error} />
          ) : runs.data?.items.length ? (
            <div className="compact-stack section">
              {runs.data.items.map((r) => (
                <Link className="integration-row" to={"/executions/" + r.id} key={r.id}>
                  <strong>{r.id}</strong>
                  <span className={"status " + r.status.toLowerCase()}>
                    {r.status.toLowerCase()}
                  </span>
                  <Icon name="arrow-up-right-from-square" />
                </Link>
              ))}
            </div>
          ) : (
            <p>No executions yet. Run this workflow to inspect its results here.</p>
          )}
        </section>
      ) : tab === "versions" ? (
        <section className="connected-panel">
          <h2>Published versions</h2>
          {w.graph ? (
            <>
              <ErrorMessage error={versions.error} />
              {versions.isPending && <p role="status">Loading version history…</p>}
              {versions.data?.versions.map((v) => (
                <div className="integration-row section" key={v.version}>
                  <div>
                    <strong>Version {v.version}</strong>
                    <p className="hint">Published {new Date(v.created_at).toLocaleString()}</p>
                  </div>
                  <Link className="btn" to={"/workflow/" + id + "?version=" + v.version}>
                    Inspect version
                  </Link>
                </div>
              ))}
            </>
          ) : (
            <p>Version {w.version} · Compiled document pipeline</p>
          )}
        </section>
      ) : (
        <section className="connected-panel">
          <h2>Workflow settings</h2>
          <p>
            Executions use an immutable published version. Save edits in Studio and publish a new
            version to change execution behavior.
          </p>
          <div className="actions section">
            {w.graph && (
              <Link className="btn" to={"/studio/" + id}>
                Edit workflow
              </Link>
            )}
            <Link className="btn" to="/settings/automations">
              Schedules & webhooks
            </Link>
            <Link className="btn" to="/settings/projects">
              Project settings
            </Link>
          </div>
          <h3 className="section">Execution policies</h3>
          <div className="compact-stack section">
            {w.steps.map((s) => (
              <div className="integration-row" key={s.key}>
                <strong>{s.name}</strong>
                <span>
                  {s.timeoutMs / 1000}s timeout · {s.retry.maxAttempts} attempts
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {launch && <Launch projectId={projectId} workflow={w} close={() => setLaunch(false)} />}
    </>
  );
}
