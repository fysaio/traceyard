import { ProjectLink as Link } from "../components/project-link";
import { Launch } from "../App";
import { api } from "../lib/api";
import type { WorkflowSummary } from "../../shared/contracts/api";
import type { RefObject } from "react";
import { Modal, Icon } from "../components/product-ui";
import { WORKFLOW_ICONS } from "../../shared/workflow/templates";
import { integrationRequest } from "../lib/integrations-api";
import { integrations } from "../lib/integrations-api";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { graphErrors, type WorkflowGraph, type GraphNode } from "../../shared/workflow/graph";
import { studioApi, type StudioWorkflow } from "../lib/studio-api";

export function Studio({ projectId }: { projectId: string }) {
  const { id = "" } = useParams(),
    cache = useQueryClient();
  const loaded = useQuery({
    queryKey: ["studio", projectId, id],
    queryFn: () => studioApi.get(projectId, id),
    enabled: !!projectId,
  });
  if (loaded.isPending) return <p role="status">Loading workflow…</p>;
  if (loaded.isError)
    return (
      <div role="alert">
        <p>{loaded.error.message}</p>
        <button className="btn" onClick={() => void loaded.refetch()}>
          Reload
        </button>
      </div>
    );
  return (
    <Editor
      key={projectId + id}
      initial={loaded.data}
      projectId={projectId}
      changed={() => {
        void cache.invalidateQueries({ queryKey: ["workflows"] });
        void cache.invalidateQueries({ queryKey: ["studio-list"] });
      }}
    />
  );
}
function Editor({
  initial,
  projectId,
  changed,
}: {
  initial: StudioWorkflow;
  projectId: string;
  changed: () => void;
}) {
  const routes = useQuery({
    queryKey: ["gateway", projectId],
    queryFn: () => integrations.gateway(projectId),
  });
  const httpConnections = useQuery({
    queryKey: ["http-connections", projectId],
    queryFn: () =>
      integrationRequest<{ items: { id: string; name: string }[] }>(projectId, "http-connections"),
  });
  const [picker, setPicker] = useState(false),
    [history, setHistory] = useState<StudioWorkflow[]>([]),
    [future, setFuture] = useState<StudioWorkflow[]>([]);
  const viewport = useRef<HTMLDivElement>(null),
    [run, setRun] = useState<WorkflowSummary | null>(null),
    [connecting, setConnecting] = useState<string | null>(null);
  const runPublished = useMutation({
    mutationFn: () => api.workflow(w.id, projectId, w.current_version),
    onSuccess: setRun,
  });
  const [w, setW] = useState(initial),
    [selected, setSelected] = useState<string | null>(null),
    [zoom, setZoom] = useState(1),
    [status, setStatus] = useState(""),
    [source, setSource] = useState("input"),
    [target, setTarget] = useState("output");
  const signature = (value: StudioWorkflow) =>
    JSON.stringify({
      name: value.name,
      description: value.description,
      graph: value.graph,
      icon: value.icon,
    });
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
  const jsonIssues = Object.entries(jsonDrafts).flatMap(([id, text]) => {
    if (!w.graph.nodes.some((n) => n.id === id)) return [];
    try {
      JSON.parse(text);
      return [];
    } catch {
      return ["Enter valid JSON for " + w.graph.nodes.find((n) => n.id === id)!.name + "."];
    }
  });
  const [saved, setSaved] = useState(signature(initial));
  const node = w.graph.nodes.find((n) => n.id === selected),
    issues = [...graphErrors(w.graph), ...jsonIssues],
    dirty = signature(w) !== saved || jsonIssues.length > 0;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const save = useMutation({
    mutationFn: (snapshot: StudioWorkflow) => studioApi.save(projectId, snapshot),
    onSuccess: (r, snapshot) => {
      setSaved(signature(snapshot));
      setW((prev) => ({ ...prev, revision: r.revision }));
      setStatus("Draft saved.");
      changed();
    },
  });
  const publish = useMutation({
    mutationFn: async (snapshot: StudioWorkflow) => {
      const result = await studioApi.save(projectId, snapshot);
      setW((prev) => ({ ...prev, revision: result.revision }));
      setSaved(signature(snapshot));
      return studioApi.publish(projectId, snapshot.id, result.revision);
    },
    onSuccess: (r) => {
      setW((prev) => ({
        ...prev,
        current_version: r.version,
        versions: [
          { version: r.version, checksum: "", created_at: new Date().toISOString() },
          ...prev.versions,
        ],
      }));
      setStatus("Published version " + r.version + ".");
      changed();
    },
  });
  const update = (fn: (graph: WorkflowGraph) => WorkflowGraph) => {
    setHistory((old) => [...old.slice(-39), w]);
    setFuture([]);
    setW((old) => ({ ...old, graph: fn(old.graph) }));
    setStatus("Unsaved changes");
  };
  function add(type: GraphNode["type"]) {
    const id = "step_" + crypto.randomUUID().slice(0, 8);
    update((g) => ({
      ...g,
      nodes: [
        ...g.nodes,
        {
          id,
          name: type[0]!.toUpperCase() + type.slice(1),
          type,
          config:
            type === "condition"
              ? { equals: true }
              : type === "literal"
                ? { value: {} }
                : type === "map"
                  ? { limit: 20, path: "" }
                  : type === "approval"
                    ? { expiresMinutes: 30 }
                    : {},
          x: 100 + (g.nodes.length % 3) * 260,
          y: 100 + Math.floor(g.nodes.length / 3) * 150,
        },
      ],
    }));
    setSelected(id);
  }
  return (
    <>
      <Link className="back" to="/workflows">
        ← Workflows
      </Link>
      <div className="page-head studio-toolbar-restored">
        <div>
          <input
            aria-label="Workflow name"
            value={w.name}
            maxLength={100}
            onChange={(e) => setW({ ...w, name: e.target.value })}
          />
          <p role="status">
            {status ||
              `Draft revision ${w.revision} · ${w.current_version ? "Published v" + w.current_version : "Not published"}`}
          </p>
        </div>
        <div className="actions">
          <button
            className="btn icon-only"
            aria-label="Undo"
            disabled={!history.length}
            onClick={() => {
              const previous = history.at(-1);
              if (previous) {
                setJsonDrafts({});
                setFuture((old) => [w, ...old]);
                setHistory((old) => old.slice(0, -1));
                setW({
                  ...previous,
                  revision: w.revision,
                  current_version: w.current_version,
                  versions: w.versions,
                });
              }
            }}
          >
            <Icon name="rotate-left" />
          </button>
          <button
            className="btn icon-only"
            aria-label="Redo"
            disabled={!future.length}
            onClick={() => {
              const next = future[0];
              if (next) {
                setJsonDrafts({});
                setHistory((old) => [...old, w]);
                setFuture((old) => old.slice(1));
                setW({
                  ...next,
                  revision: w.revision,
                  current_version: w.current_version,
                  versions: w.versions,
                });
              }
            }}
          >
            <Icon name="rotate-right" />
          </button>
          <button
            className="btn"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob(
                  [
                    JSON.stringify(
                      {
                        schemaVersion: 1,
                        name: w.name,
                        description: w.description,
                        graph: w.graph,
                        icon: w.icon ?? "diagram-project",
                      },
                      null,
                      2,
                    ),
                  ],
                  { type: "application/json" },
                ),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = w.id + ".traceyard.json";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Export workflow
          </button>
          <button
            className="btn"
            disabled={save.isPending || publish.isPending || !dirty || jsonIssues.length > 0}
            onClick={() => save.mutate(w)}
          >
            Save draft
          </button>
          {w.current_version > 0 && (
            <button
              className="btn"
              disabled={runPublished.isPending}
              onClick={() => runPublished.mutate()}
            >
              <Icon name="play" />
              Run v{w.current_version}
            </button>
          )}
          <button
            className="btn primary"
            disabled={publish.isPending || save.isPending || issues.length > 0 || !w.name.trim()}
            onClick={() => publish.mutate(w)}
          >
            {publish.isPending ? "Publishing…" : "Publish version"}
          </button>
        </div>
      </div>
      <div className="studio-editor-layout">
        <div>
          <div className="actions studio-add">
            <button className="btn primary" onClick={() => setPicker(true)}>
              <Icon name="plus" />
              Add step
            </button>
            <button
              className="btn"
              onClick={() => {
                const ordered = w.graph.nodes;
                update((g) => ({
                  ...g,
                  nodes: ordered.map((n, i) => ({
                    ...n,
                    x: 70 + (i % 4) * 290,
                    y: 100 + Math.floor(i / 4) * 180,
                  })),
                }));
              }}
            >
              Auto-layout
            </button>
          </div>
          <GraphCanvas
            viewportRef={viewport}
            connectFrom={(id) => {
              setConnecting(id);
              setStatus("Select an input port to connect this step.");
            }}
            connectTo={(id) => {
              if (
                connecting &&
                connecting !== id &&
                !w.graph.edges.some(([a, b]) => a === connecting && b === id)
              ) {
                update((g) => ({ ...g, edges: [...g.edges, [connecting, id]] }));
                setConnecting(null);
              }
            }}
            graph={w.graph}
            zoom={zoom}
            selected={selected}
            select={setSelected}
            move={(id, x, y) =>
              update((g) => ({
                ...g,
                nodes: g.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
              }))
            }
          />
          <div className="actions section">
            <button
              className="btn"
              aria-label="Zoom out"
              onClick={() => setZoom(Math.max(0.4, zoom - 0.1))}
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              className="btn"
              aria-label="Zoom in"
              onClick={() => setZoom(Math.min(1.5, zoom + 0.1))}
            >
              +
            </button>
            <button
              className="btn"
              onClick={() => {
                if (viewport.current) {
                  const width = Math.max(...w.graph.nodes.map((n) => n.x + 260)),
                    height = Math.max(...w.graph.nodes.map((n) => n.y + 130));
                  setZoom(
                    Math.max(
                      0.25,
                      Math.min(
                        1.25,
                        (viewport.current.clientWidth - 32) / width,
                        (viewport.current.clientHeight - 32) / height,
                      ),
                    ),
                  );
                  viewport.current.scrollTo(0, 0);
                }
              }}
            >
              <Icon name="expand" />
              Fit graph
            </button>
            <button className="btn" onClick={() => setZoom(1)}>
              Actual size
            </button>
          </div>
        </div>
        <aside className="connected-panel">
          <h2>{node ? "Configure step" : "Workflow"}</h2>
          {!node && (
            <>
              <label>
                Description
                <textarea
                  maxLength={500}
                  value={w.description}
                  onChange={(e) => setW({ ...w, description: e.target.value })}
                />
              </label>
              <label>Workflow icon</label>
              <div className="icon-picker">
                {WORKFLOW_ICONS.map((icon) => (
                  <button
                    className={"icon-option " + (w.icon === icon ? "selected" : "")}
                    key={icon}
                    aria-label={icon.replaceAll("-", " ")}
                    aria-pressed={w.icon === icon}
                    onClick={() => setW({ ...w, icon })}
                  >
                    <Icon name={icon} />
                  </button>
                ))}
              </div>
            </>
          )}
          {node && (
            <>
              <label htmlFor="step-name">Step name</label>
              <input
                id="step-name"
                value={node.name}
                onChange={(e) =>
                  update((g) => ({
                    ...g,
                    nodes: g.nodes.map((n) =>
                      n.id === node.id ? { ...n, name: e.target.value } : n,
                    ),
                  }))
                }
              />
              {["pick", "map", "condition"].includes(node.type) && (
                <>
                  <label htmlFor="pick-path">Field path</label>
                  <input
                    id="pick-path"
                    placeholder="customer.name"
                    value={node.config.path ?? ""}
                    onChange={(e) =>
                      update((g) => ({
                        ...g,
                        nodes: g.nodes.map((n) =>
                          n.id === node.id
                            ? { ...n, config: { ...n.config, path: e.target.value } }
                            : n,
                        ),
                      }))
                    }
                  />
                </>
              )}
              {node.type === "literal" && (
                <Literal
                  key={node.id}
                  value={node.config.value}
                  text={jsonDrafts[node.id]}
                  onText={(text) => setJsonDrafts((old) => ({ ...old, [node.id]: text }))}
                  save={(value) =>
                    update((g) => ({
                      ...g,
                      nodes: g.nodes.map((n) =>
                        n.id === node.id ? { ...n, config: { value } } : n,
                      ),
                    }))
                  }
                />
              )}
              {node.type === "model" && (
                <>
                  <label>
                    Model route
                    <select
                      value={node.config.routeId ?? ""}
                      onChange={(e) =>
                        update((g) => ({
                          ...g,
                          nodes: g.nodes.map((n) =>
                            n.id === node.id
                              ? { ...n, config: { ...n.config, routeId: e.target.value } }
                              : n,
                          ),
                        }))
                      }
                    >
                      <option value="">Choose a route</option>
                      {routes.data?.routes.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Link className="text-link" to="/gateway">
                    Configure routes in Gateway
                  </Link>
                  {routes.error && <p role="alert">{routes.error.message}</p>}
                </>
              )}
              {["model", "approval"].includes(node.type) && (
                <label>
                  {node.type === "model" ? "Instructions" : "Review prompt"}
                  <textarea
                    maxLength={6000}
                    value={node.config.prompt ?? ""}
                    onChange={(e) =>
                      update((g) => ({
                        ...g,
                        nodes: g.nodes.map((n) =>
                          n.id === node.id
                            ? { ...n, config: { ...n.config, prompt: e.target.value } }
                            : n,
                        ),
                      }))
                    }
                  />
                </label>
              )}
              {node.type === "approval" && (
                <label>
                  Expires after (minutes)
                  <input
                    type="number"
                    min="1"
                    max="60"
                    required
                    value={node.config.expiresMinutes ?? 30}
                    onChange={(e) =>
                      update((g) => ({
                        ...g,
                        nodes: g.nodes.map((n) =>
                          n.id === node.id
                            ? {
                                ...n,
                                config: { ...n.config, expiresMinutes: Number(e.target.value) },
                              }
                            : n,
                        ),
                      }))
                    }
                  />
                </label>
              )}
              {node.type === "map" && (
                <label>
                  Maximum items
                  <input
                    type="number"
                    min="1"
                    max="20"
                    required
                    value={node.config.limit ?? 20}
                    onChange={(e) =>
                      update((g) => ({
                        ...g,
                        nodes: g.nodes.map((n) =>
                          n.id === node.id
                            ? { ...n, config: { ...n.config, limit: Number(e.target.value) } }
                            : n,
                        ),
                      }))
                    }
                  />
                </label>
              )}
              {node.type === "condition" && (
                <>
                  <Literal
                    key={node.id + "equals"}
                    label="Compare field to JSON"
                    value={node.config.equals}
                    text={jsonDrafts[node.id]}
                    onText={(text) => setJsonDrafts((old) => ({ ...old, [node.id]: text }))}
                    save={(value) =>
                      update((g) => ({
                        ...g,
                        nodes: g.nodes.map((n) =>
                          n.id === node.id ? { ...n, config: { ...n.config, equals: value } } : n,
                        ),
                      }))
                    }
                  />
                  {(["thenTarget", "elseTarget"] as const).map((field) => (
                    <label key={field}>
                      {field === "thenTarget"
                        ? "When equal, continue to"
                        : "Otherwise, continue to"}
                      <select
                        value={node.config[field] ?? ""}
                        onChange={(e) =>
                          update((g) => ({
                            ...g,
                            nodes: g.nodes.map((n) =>
                              n.id === node.id
                                ? { ...n, config: { ...n.config, [field]: e.target.value } }
                                : n,
                            ),
                          }))
                        }
                      >
                        <option value="">Choose a connected step</option>
                        {w.graph.edges
                          .filter(([a]) => a === node.id)
                          .map(([, b]) => (
                            <option key={b} value={b}>
                              {w.graph.nodes.find((n) => n.id === b)?.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  ))}
                </>
              )}
              {node.type === "http" && (
                <>
                  <label>
                    HTTP connection
                    <select
                      value={node.config.connectionId ?? ""}
                      onChange={(e) =>
                        update((g) => ({
                          ...g,
                          nodes: g.nodes.map((n) =>
                            n.id === node.id
                              ? { ...n, config: { ...n.config, connectionId: e.target.value } }
                              : n,
                          ),
                        }))
                      }
                    >
                      <option value="">Choose a connection</option>
                      {httpConnections.data?.items.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Link className="text-link" to="/settings/connections">
                    Configure HTTP connections
                  </Link>
                  {httpConnections.error && <p role="alert">{httpConnections.error.message}</p>}
                </>
              )}
              {["http", "model"].includes(node.type) && (
                <fieldset>
                  <legend>Failure handling</legend>
                  <label>
                    Maximum attempts
                    <select
                      value={node.config.retry?.maxAttempts ?? 1}
                      onChange={(e) =>
                        update((g) => ({
                          ...g,
                          nodes: g.nodes.map((n) =>
                            n.id === node.id
                              ? {
                                  ...n,
                                  config: {
                                    ...n.config,
                                    retry: {
                                      maxAttempts: Number(e.target.value),
                                      baseDelayMs: 1000,
                                      backoff: "exponential",
                                    },
                                  },
                                }
                              : n,
                          ),
                        }))
                      }
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n === 1 ? "1 — no automatic retry" : `${n} attempts`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="hint">
                    Only temporary failures retry, with increasing delays. Completed steps remain
                    retained for manual recovery.
                  </p>
                </fieldset>
              )}
              {node.type === "parse" && (
                <label>
                  Required fields (comma separated)
                  <input
                    value={node.config.requiredFields?.join(", ") ?? ""}
                    onChange={(e) =>
                      update((g) => ({
                        ...g,
                        nodes: g.nodes.map((n) =>
                          n.id === node.id
                            ? {
                                ...n,
                                config: {
                                  ...n.config,
                                  requiredFields: e.target.value
                                    .split(",")
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                                },
                              }
                            : n,
                        ),
                      }))
                    }
                  />
                </label>
              )}
              <p className="hint">
                {
                  {
                    http: "Sends its input as JSON to the captured HTTP connection. GET requests omit the body.",
                    parse: "Parses text as JSON and checks that configured fields are present.",
                    input: "Receives the JSON submitted when the workflow runs.",
                    literal: "Produces the configured JSON value.",
                    pick: "Selects a field from its single input. Use dot notation.",
                    merge: "Combines incoming results into an array in connection order.",
                    output: "Records the result from its single input.",
                    model:
                      "Calls the captured Gateway route with instructions and incoming JSON. Returns text, provider and measured usage.",
                    approval:
                      "Waits for a decision in Approvals before passing its input onward. Rejection or expiry stops the execution.",
                    map: "Selects the field path from each item of an array, up to the configured limit.",
                    condition:
                      "Compares the selected field to JSON and runs one path. Steps exclusive to the other path are skipped. Rejoin paths with a Merge step.",
                  }[node.type]
                }
              </p>
              {!["input", "output"].includes(node.type) && (
                <button
                  className="btn section"
                  onClick={() => {
                    update((g) => ({
                      nodes: g.nodes.filter((n) => n.id !== node.id),
                      edges: g.edges.filter(([a, b]) => a !== node.id && b !== node.id),
                    }));
                    setSelected(null);
                  }}
                >
                  Remove step
                </button>
              )}
            </>
          )}
          <h3 className="section">Connect steps</h3>
          <label htmlFor="source">From</label>
          <select id="source" value={source} onChange={(e) => setSource(e.target.value)}>
            {w.graph.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
          <label htmlFor="target">To</label>
          <select id="target" value={target} onChange={(e) => setTarget(e.target.value)}>
            {w.graph.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
          <button
            className="btn section"
            disabled={
              source === target ||
              w.graph.edges.some(([a, b]) => a === source && b === target) ||
              !w.graph.nodes.some((n) => n.id === source) ||
              !w.graph.nodes.some((n) => n.id === target)
            }
            onClick={() => update((g) => ({ ...g, edges: [...g.edges, [source, target]] }))}
          >
            Add connection
          </button>
          <div className="connection-list">
            {w.graph.edges.map(([a, b], i) => (
              <div key={a + ":" + b}>
                <span>
                  {w.graph.nodes.find((n) => n.id === a)?.name} →{" "}
                  {w.graph.nodes.find((n) => n.id === b)?.name}
                </span>
                <button
                  className="btn"
                  aria-label={`Remove connection ${a} to ${b}`}
                  onClick={() =>
                    update((g) => ({ ...g, edges: g.edges.filter((_, j) => j !== i) }))
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </aside>
      </div>
      {issues.length > 0 && (
        <section className="request-error" aria-label="Workflow validation">
          <h3>Before publishing</h3>
          <ul>
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      )}
      {(save.error || publish.error) && (
        <p role="alert">
          {save.error?.message || publish.error?.message} Your local edits remain on screen.
        </p>
      )}
      {run && <Launch workflow={run} projectId={projectId} close={() => setRun(null)} />}
      {runPublished.error && <p role="alert">{runPublished.error.message}</p>}
      {picker && (
        <Modal title="Add step" close={() => setPicker(false)}>
          <div className="creation-options">
            {(
              [
                ["literal", "code", "Literal JSON"],
                ["pick", "filter", "Select field"],
                ["parse", "code", "Parse JSON"],
                ["merge", "layer-group", "Merge results"],
                ["map", "arrows-rotate", "Map items"],
                ["condition", "code-branch", "Condition"],
                ["model", "robot", "Model"],
                ["http", "globe", "HTTP tool"],
                ["approval", "check-double", "Approval"],
              ] as const
            ).map(([type, icon, label]) => (
              <button
                key={type}
                onClick={() => {
                  add(type);
                  setPicker(false);
                }}
              >
                <Icon name={icon} />
                <strong>{label}</strong>
                <Icon name="plus" />
              </button>
            ))}
          </div>
        </Modal>
      )}
      <section className="connected-panel section">
        <h2>Published versions</h2>
        {w.versions.length ? (
          w.versions.map((v) => (
            <div className="stat-row" key={v.version}>
              <span>
                Version {v.version} · {new Date(v.created_at).toLocaleString()}
              </span>
              <Link className="btn" to={`/workflow/${w.id}?version=${v.version}`}>
                Inspect and run
              </Link>
            </div>
          ))
        ) : (
          <p>Publish a valid graph to make it executable.</p>
        )}
      </section>
    </>
  );
}
function Literal({
  value,
  save,
  text,
  onText,
  label = "JSON value",
}: {
  value: unknown;
  save: (value: unknown) => void;
  text?: string;
  onText: (text: string) => void;
  label?: string;
}) {
  const displayed = text ?? JSON.stringify(value ?? {}, null, 2);
  let error = "";
  try {
    JSON.parse(displayed);
  } catch {
    error = "Enter valid JSON before saving or publishing.";
  }
  return (
    <>
      <label>
        {label}
        <textarea
          value={displayed}
          aria-invalid={!!error}
          onChange={(e) => {
            onText(e.target.value);
            try {
              save(JSON.parse(e.target.value) as unknown);
            } catch {
              /* Keep incomplete edits visible. */
            }
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
function GraphCanvas({
  viewportRef,
  connectFrom,
  connectTo,
  graph,
  zoom,
  selected,
  select,
  move,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  connectFrom: (id: string) => void;
  connectTo: (id: string) => void;
  graph: WorkflowGraph;
  zoom: number;
  selected: string | null;
  select: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null),
    width = Math.max(900, ...graph.nodes.map((n) => n.x + 260)),
    height = Math.max(460, ...graph.nodes.map((n) => n.y + 130));
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 4096 / width, 4096 / height);
    c.width = width * dpr;
    c.height = height * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = "#929292";
    ctx.lineWidth = 2;
    for (const [a, b] of graph.edges) {
      const from = graph.nodes.find((n) => n.id === a),
        to = graph.nodes.find((n) => n.id === b);
      if (!from || !to) continue;
      ctx.beginPath();
      ctx.moveTo(from.x + 216, from.y + 46);
      ctx.bezierCurveTo(from.x + 260, from.y + 46, to.x - 44, to.y + 46, to.x, to.y + 46);
      ctx.stroke();
    }
  }, [graph, width, height]);
  return (
    <div
      ref={viewportRef}
      className="studio-real-viewport"
      aria-label="Workflow graph"
      onPointerDown={(e) => {
        if (e.pointerType !== "mouse" || (e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        const el = e.currentTarget,
          start = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
        el.setPointerCapture(e.pointerId);
        const motion = (event: PointerEvent) => {
          el.scrollLeft = start.left - (event.clientX - start.x);
          el.scrollTop = start.top - (event.clientY - start.y);
        };
        const end = () => {
          el.removeEventListener("pointermove", motion);
          el.removeEventListener("pointerup", end);
          el.removeEventListener("pointercancel", end);
        };
        el.addEventListener("pointermove", motion);
        el.addEventListener("pointerup", end, { once: true });
        el.addEventListener("pointercancel", end, { once: true });
      }}
    >
      <div style={{ width: width * zoom, height: height * zoom }}>
        <div
          className="studio-real-graph"
          style={{ width, height, transform: `scale(${zoom})`, transformOrigin: "top left" }}
        >
          <canvas ref={ref} style={{ position: "absolute", width, height }} aria-hidden="true" />
          {graph.nodes.flatMap((node) => [
            node.type !== "input" && (
              <button
                key={node.id + ":in"}
                className="node-port input-port"
                aria-label={"Connect into " + node.name}
                style={{ left: node.x - 8, top: node.y + 36 }}
                onClick={() => connectTo(node.id)}
              />
            ),
            node.type !== "output" && (
              <button
                key={node.id + ":out"}
                className="node-port output-port"
                aria-label={"Connect from " + node.name}
                style={{ left: node.x + 208, top: node.y + 36 }}
                onClick={() => connectFrom(node.id)}
              />
            ),
          ])}
          {graph.nodes.map((node) => (
            <button
              key={node.id}
              className={`graph-node ${selected === node.id ? "selected" : ""}`}
              style={{ left: node.x, top: node.y }}
              onClick={() => select(node.id)}
              onKeyDown={(e) => {
                if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
                  e.preventDefault();
                  move(
                    node.id,
                    Math.max(
                      0,
                      node.x + (e.key === "ArrowRight" ? 20 : e.key === "ArrowLeft" ? -20 : 0),
                    ),
                    Math.max(
                      0,
                      node.y + (e.key === "ArrowDown" ? 20 : e.key === "ArrowUp" ? -20 : 0),
                    ),
                  );
                }
              }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const start = { x: e.clientX, y: e.clientY, nx: node.x, ny: node.y },
                  el = e.currentTarget;
                let x = node.x,
                  y = node.y;
                const motion = (ev: PointerEvent) => {
                  x = Math.min(10000, Math.max(0, start.nx + (ev.clientX - start.x) / zoom));
                  y = Math.min(10000, Math.max(0, start.ny + (ev.clientY - start.y) / zoom));
                  el.style.left = x + "px";
                  el.style.top = y + "px";
                };
                const end = () => {
                  el.removeEventListener("pointermove", motion);
                  el.removeEventListener("pointerup", end);
                  el.removeEventListener("pointercancel", end);
                  move(node.id, x, y);
                  select(node.id);
                };
                el.addEventListener("pointermove", motion);
                el.addEventListener("pointerup", end, { once: true });
                el.addEventListener("pointercancel", end, { once: true });
              }}
            >
              <span className="node-type">{node.type}</span>
              <strong>{node.name}</strong>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
