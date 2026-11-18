import { ProjectLink as Link } from "../components/project-link";
import { useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { WORKFLOW_TEMPLATES, templateById } from "../../shared/workflow/templates";
import { api } from "../lib/api";
import { studioApi, type StudioWorkflow } from "../lib/studio-api";
import { readPreference, savePreference } from "../lib/workspace";
import { Modal, Icon, ErrorMessage, downloadJson } from "../components/product-ui";
import { Launch } from "../App";
import type { WorkflowGraph } from "../../shared/workflow/graph";
import type { WorkflowSummary } from "../../shared/contracts/api";
export function WorkflowLibrary({ projectId }: { projectId: string }) {
  const cache = useQueryClient(),
    navigate = useNavigate(),
    file = useRef<HTMLInputElement>(null),
    [params, setParams] = useSearchParams(),
    tab = params.get("tab") === "templates" ? "templates" : "mine",
    [layout, setLayout] = useState(() => readPreference("workflow-layout", "list")),
    [search, setSearch] = useState(""),
    [menu, setMenu] = useState<"create" | StudioWorkflow["id"] | null>(null),
    [launch, setLaunch] = useState<WorkflowSummary | null>(null);
  const q = useQuery({
      queryKey: ["studio-list", projectId],
      queryFn: () => studioApi.list(projectId),
    }),
    catalog = useQuery({
      queryKey: ["workflows", projectId],
      queryFn: () => api.workflows(projectId),
    });
  const changed = () => {
    void cache.invalidateQueries({ queryKey: ["studio-list", projectId] });
    void cache.invalidateQueries({ queryKey: ["workflows", projectId] });
  };
  const create = useMutation({
      mutationFn: (templateId?: string) =>
        studioApi.create(
          projectId,
          templateId === "agent" ? "Untitled agent" : "Untitled workflow",
          templateId,
        ),
      onSuccess: (w) => {
        changed();
        navigate("/studio/" + w.id + "?project=" + projectId);
      },
    }),
    importFile = useMutation({
      mutationFn: async (f: File) => {
        if (f.size > 30000) throw Error("Workflow JSON files must be smaller than 30 KB.");
        let data: unknown;
        try {
          data = JSON.parse(await f.text());
        } catch {
          throw Error("Choose a valid Traceyard workflow JSON file.");
        }
        return studioApi.import(projectId, data);
      },
      onSuccess: (w) => {
        changed();
        navigate("/studio/" + w.id + "?project=" + projectId);
      },
    }),
    action = useMutation({
      mutationFn: async ({
        id,
        kind,
      }: {
        id: string;
        kind: "duplicate" | "export" | "archive";
      }) => {
        if (kind === "archive") {
          await studioApi.archive(projectId, id);
          return;
        }
        const w = await studioApi.get(projectId, id),
          data = {
            schemaVersion: 1,
            name: w.name,
            description: w.description,
            icon: w.icon ?? "diagram-project",
            graph: w.graph,
          };
        if (kind === "export") {
          downloadJson(w.name + ".traceyard.json", data);
          return;
        }
        return studioApi.import(projectId, { ...data, name: w.name + " copy" });
      },
      onSuccess: (w) => {
        changed();
        setMenu(null);
        if (w) navigate("/studio/" + w.id + "?project=" + projectId);
      },
    }),
    run = useMutation({
      mutationFn: (id: string) => api.workflow(id, projectId),
      onSuccess: setLaunch,
    });
  const rows =
      q.data?.items.filter((w) =>
        (w.name + " " + w.description).toLowerCase().includes(search.toLowerCase()),
      ) ?? [],
    active = q.data?.items.find((w) => w.id === menu);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workflows & agents</h1>
          <p>Build executable workflows, inspect every step and recover failed work.</p>
        </div>
        {(tab === "templates" || !!q.data?.items.length || q.isError) && (
          <button className="btn primary" onClick={() => setMenu("create")}>
            <Icon name="plus" />
            Create workflow
          </button>
        )}
      </div>
      <div className="content-toolbar">
        <div className="product-tabs" role="tablist">
          {[
            ["mine", "My workflows"],
            ["templates", "Templates"],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={id === tab}
              onClick={() => setParams(id === "mine" ? {} : { tab: id! })}
            >
              {label}
            </button>
          ))}
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
                onClick={() => {
                  setLayout(x);
                  savePreference("workflow-layout", x);
                }}
              >
                <Icon name={x === "list" ? "list" : "border-all"} />
                <span>{x === "list" ? "List view" : "Grid view"}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <ErrorMessage error={create.error || importFile.error || action.error || run.error} />
      {tab === "templates" ? (
        <>
          <div className={"template-grid " + (layout === "list" ? "template-list" : "")}>
            {WORKFLOW_TEMPLATES.filter((t) =>
              (t.name + t.description).toLowerCase().includes(search.toLowerCase()),
            ).map((t) => (
              <Link className="template-card" to={"/template/" + t.id} key={t.id}>
                <span className="workflow-icon">
                  <Icon name={t.icon} />
                </span>
                <div>
                  <h2>{t.name}</h2>
                  <p>{t.description}</p>
                  <span className="quiet-meta">
                    {t.graph.nodes.length} steps {t.setup.length ? "· Requires configuration" : ""}
                  </span>
                </div>
                <Icon name="arrow-right" />
              </Link>
            ))}
          </div>
          {catalog.data
            ?.filter((w) => !q.data?.items.some((d) => d.id === w.id))
            .map((w) => (
              <section className="connected-panel section" key={w.id}>
                <h2>Document pipeline</h2>
                <p>
                  Run the built-in document extraction workflow or inspect its failure scenarios.
                </p>
                <Link className="btn section" to={"/workflow/" + w.id}>
                  Open document pipeline
                </Link>
              </section>
            ))}
        </>
      ) : q.isPending ? (
        <p className="loading-state" role="status">
          Loading workflows…
        </p>
      ) : q.isError ? (
        <>
          <ErrorMessage error={q.error} />
          <button className="btn" onClick={() => void q.refetch()}>
            Reload workflows
          </button>
        </>
      ) : rows.length ? (
        <div className={"saved-workflows " + layout}>
          {rows.map((w) => (
            <article className="saved-workflow" key={w.id}>
              <Link
                className="workflow-main"
                to={(w.current_version ? "/workflow/" : "/studio/") + w.id}
              >
                <span className="workflow-icon">
                  <Icon name={w.icon ?? "diagram-project"} />
                </span>
                <div>
                  <h2>{w.name}</h2>
                  <p>{w.description || "Add a description in Studio."}</p>
                  <div className="quiet-meta">
                    <span>
                      {w.current_version ? "Version " + w.current_version : "Unpublished draft"}
                    </span>
                    <span>Draft revision {w.revision}</span>
                  </div>
                </div>
              </Link>
              <div className="workflow-actions">
                <Link
                  className="btn icon-only workflow-edit"
                  aria-label={"Edit " + w.name}
                  to={"/studio/" + w.id}
                >
                  <Icon name="pen" />
                </Link>
                {w.current_version > 0 ? (
                  <button className="btn" disabled={run.isPending} onClick={() => run.mutate(w.id)}>
                    <Icon name="play" />
                    Run
                  </button>
                ) : (
                  <Link className="btn" to={"/studio/" + w.id}>
                    Continue editing
                  </Link>
                )}
                <button
                  className="btn icon-only"
                  aria-label={"Actions for " + w.name}
                  onClick={() => setMenu(w.id)}
                >
                  <Icon name="ellipsis" />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="library-empty">
          <span className="workflow-icon">
            <Icon name="diagram-project" />
          </span>
          <h2>{search ? "No matching workflows." : "Your first workflow starts here."}</h2>
          <p>{search ? "Try another search." : "Create a workflow or use an editable template."}</p>
          <div className="actions">
            <button
              className="btn primary"
              onClick={() => (search ? setSearch("") : setMenu("create"))}
            >
              {search ? "Clear search" : "Create workflow"}
            </button>
            <button className="btn" onClick={() => setParams({ tab: "templates" })}>
              Explore templates
            </button>
          </div>
        </section>
      )}
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        aria-label="Import Traceyard workflow JSON"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFile.mutate(f);
          e.target.value = "";
        }}
      />
      {menu === "create" && (
        <Modal title="Create workflow" close={() => setMenu(null)}>
          <div className="creation-options">
            {[
              ["blank", "file", "Blank workflow", "Start with input and output."],
              ["agent", "robot", "AI agent", "Generate a response and review it."],
              [
                "templates",
                "layer-group",
                "Start from a template",
                "Use a complete, editable workflow.",
              ],
              ["import", "file-import", "Import JSON", "A workflow exported from Traceyard."],
            ].map(([id, icon, title, detail]) => (
              <button
                disabled={create.isPending || importFile.isPending}
                key={id}
                onClick={() => {
                  if (id === "templates") {
                    setParams({ tab: "templates" });
                    setMenu(null);
                  } else if (id === "import") {
                    file.current?.click();
                    setMenu(null);
                  } else create.mutate(id === "agent" ? "agent" : undefined);
                }}
              >
                <Icon name={icon!} />
                <div>
                  <strong>{title}</strong>
                  <span>{detail}</span>
                </div>
                <Icon name="arrow-right" />
              </button>
            ))}
          </div>
          <ErrorMessage error={create.error} />
        </Modal>
      )}
      {active && (
        <Modal title={active.name} menu close={() => setMenu(null)}>
          <div className="project-menu-list">
            <Link className="menu-action" to={"/studio/" + active.id} onClick={() => setMenu(null)}>
              <Icon name="pen" />
              Edit in Studio
            </Link>
            {active.current_version > 0 && (
              <Link
                className="menu-action"
                to={"/workflow/" + active.id}
                onClick={() => setMenu(null)}
              >
                <Icon name="clock-rotate-left" />
                Version history & executions
              </Link>
            )}
            {[
              ["duplicate", "copy", "Duplicate"],
              ["export", "download", "Export JSON"],
              ["archive", "box-archive", "Archive workflow"],
            ].map(([kind, icon, label]) => (
              <button
                className="menu-action"
                disabled={action.isPending}
                key={kind}
                onClick={() =>
                  action.mutate({ id: active.id, kind: kind as "duplicate" | "export" | "archive" })
                }
              >
                <Icon name={icon!} />
                {label}
              </button>
            ))}
          </div>
          <ErrorMessage error={action.error} />
        </Modal>
      )}
      {launch && <Launch projectId={projectId} workflow={launch} close={() => setLaunch(null)} />}
    </>
  );
}
export function TemplateDetail({ projectId }: { projectId: string }) {
  const { id = "" } = useParams(),
    t = templateById(id),
    navigate = useNavigate(),
    cache = useQueryClient(),
    create = useMutation({
      mutationFn: () => studioApi.create(projectId, t!.name, t!.id),
      onSuccess: (w) => {
        void cache.invalidateQueries({ queryKey: ["studio-list", projectId] });
        navigate("/studio/" + w.id + "?project=" + projectId);
      },
    });
  if (!t)
    return (
      <p>
        Template not found. <Link to="/workflows?tab=templates">Return to templates</Link>
      </p>
    );
  return (
    <>
      <Link className="back" to="/workflows?tab=templates">
        <Icon name="arrow-left" /> Templates
      </Link>
      <div className="page-head">
        <div>
          <h1>{t.name}</h1>
          <p>{t.description}</p>
        </div>
        <button className="btn primary" disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : "Use template"}
        </button>
      </div>
      <WorkflowDiagram graph={t.graph} />
      {t.setup.length > 0 && (
        <section className="connected-panel section">
          <h2>Set up this workflow</h2>
          {t.setup.map((text) => (
            <p key={text}>{text}</p>
          ))}
          <Link className="text-link" to={id === "sync" ? "/settings/connections" : "/gateway"}>
            {id === "sync" ? "Configure HTTP connections" : "Open Gateway"}{" "}
            <Icon name="arrow-right" />
          </Link>
        </section>
      )}
      <section className="section">
        <h2>Input</h2>
        <pre className="code">{JSON.stringify(t.input, null, 2)}</pre>
      </section>
      <ErrorMessage error={create.error} />
    </>
  );
}
export function WorkflowDiagram({ graph }: { graph: WorkflowGraph }) {
  return (
    <div className="readable-graph" aria-label="Workflow steps">
      {graph.nodes.map((n) => (
        <article className="readable-node" key={n.id}>
          <span className="node-type">
            <Icon
              name={
                n.type === "model"
                  ? "robot"
                  : n.type === "approval"
                    ? "check-double"
                    : n.type === "http"
                      ? "globe"
                      : "cube"
              }
            />
            {n.type}
          </span>
          <strong>{n.name}</strong>
          <p>
            {graph.edges
              .filter(([a]) => a === n.id)
              .map(([, b]) => graph.nodes.find((x) => x.id === b)?.name)
              .join(" → ") || "Workflow result"}
          </p>
        </article>
      ))}
    </div>
  );
}
