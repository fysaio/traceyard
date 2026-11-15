import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
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
  const [w, setW] = useState(initial),
    [selected, setSelected] = useState<string | null>(null),
    [zoom, setZoom] = useState(1),
    [status, setStatus] = useState(""),
    [source, setSource] = useState("input"),
    [target, setTarget] = useState("output");
  const signature = (value: StudioWorkflow) =>
    JSON.stringify({ name: value.name, description: value.description, graph: value.graph });
  const [saved, setSaved] = useState(signature(initial));
  const node = w.graph.nodes.find((n) => n.id === selected),
    issues = graphErrors(w.graph),
    dirty = signature(w) !== saved;
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
          config: type === "literal" ? { value: {} } : {},
          x: 100 + (g.nodes.length % 3) * 260,
          y: 100 + Math.floor(g.nodes.length / 3) * 150,
        },
      ],
    }));
    setSelected(id);
  }
  return (
    <>
      <Link className="back" to="/">
        ← Workflows
      </Link>
      <div className="page-head">
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
            className="btn"
            disabled={save.isPending || publish.isPending || !dirty}
            onClick={() => save.mutate(w)}
          >
            Save draft
          </button>
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
            {(["literal", "pick", "merge"] as const).map((type) => (
              <button key={type} className="btn" onClick={() => add(type)}>
                + {type}
              </button>
            ))}
          </div>
          <GraphCanvas
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
            <button className="btn" onClick={() => setZoom(1)}>
              Actual size
            </button>
          </div>
        </div>
        <aside className="connected-panel">
          <h2>{node ? "Configure step" : "Connections"}</h2>
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
              {node.type === "pick" && (
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
                          n.id === node.id ? { ...n, config: { path: e.target.value } } : n,
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
              <p className="hint">
                {
                  {
                    input: "Receives the JSON submitted when the workflow runs.",
                    literal: "Produces the configured JSON value.",
                    pick: "Selects a field from its single input. Use dot notation.",
                    merge: "Combines incoming results into an array in connection order.",
                    output: "Records the result from its single input.",
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
function Literal({ value, save }: { value: unknown; save: (value: unknown) => void }) {
  const [text, setText] = useState(JSON.stringify(value ?? {}, null, 2)),
    [error, setError] = useState("");
  return (
    <>
      <label htmlFor="literal-value">JSON value</label>
      <textarea
        id="literal-value"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            save(JSON.parse(e.target.value) as unknown);
            setError("");
          } catch {
            setError("Enter valid JSON. The last valid value is retained.");
          }
        }}
      />
      {error && <p role="alert">{error}</p>}
    </>
  );
}
function GraphCanvas({
  graph,
  zoom,
  selected,
  select,
  move,
}: {
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
    const dpr = window.devicePixelRatio || 1;
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
    <div className="studio-real-viewport" aria-label="Workflow graph">
      <div style={{ width: width * zoom, height: height * zoom }}>
        <div
          className="studio-real-graph"
          style={{ width, height, transform: `scale(${zoom})`, transformOrigin: "top left" }}
        >
          <canvas ref={ref} style={{ position: "absolute", width, height }} aria-hidden="true" />
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
