import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, ErrorNotice } from "./integrations";
export function Compare({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams(),
    [left, setLeft] = useState(params.get("left") ?? ""),
    [right, setRight] = useState(params.get("right") ?? "");
  const options = useQuery({
      queryKey: ["compare-runs", projectId],
      queryFn: () => api.runs({ projectId, limit: 100 }),
    }),
    a = useQuery({
      queryKey: ["run", params.get("left")],
      queryFn: () => api.run(params.get("left")!),
      enabled: !!params.get("left"),
    }),
    b = useQuery({
      queryKey: ["run", params.get("right")],
      queryFn: () => api.run(params.get("right")!),
      enabled: !!params.get("right"),
    });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Compare executions</h1>
          <p>Inspect recorded output and step timing side by side.</p>
        </div>
      </div>
      <form
        className="form-grid connected-panel"
        onSubmit={(e) => {
          e.preventDefault();
          setParams({ left, right });
        }}
      >
        {[
          { name: "First execution", value: left, set: setLeft },
          { name: "Second execution", value: right, set: setRight },
        ].map((c) => (
          <label key={c.name}>
            {c.name}
            <select required value={c.value} onChange={(e) => c.set(e.target.value)}>
              <option value="">Choose an execution</option>
              {options.data?.items.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.workflow.name} · {r.id}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button className="btn primary" disabled={!!left && left === right}>
          Compare
        </button>
      </form>
      <ErrorNotice error={options.error || a.error || b.error} />
      {(a.isFetching || b.isFetching) && <p role="status">Loading executions…</p>}
      <div className="integration-columns section">
        {[a.data, b.data].map(
          (r, i) =>
            r && (
              <section className="connected-panel" key={i}>
                <h2>{r.workflow.name}</h2>
                <Link className="text-link" to={"/executions/" + r.id}>
                  {r.id}
                </Link>
                <div className="quiet-meta section">
                  <Badge status={r.status} />
                  <span>Version {r.workflow.version}</span>
                  <span>{r.durationMs ?? "—"}ms</span>
                </div>
                <h3 className="section">Output</h3>
                <pre className="code">{JSON.stringify(r.output, null, 2)}</pre>
                <h3 className="section">Steps</h3>
                <div className="compact-stack">
                  {r.steps.map((s) => (
                    <div className="integration-row" key={s.id}>
                      <strong>{s.name}</strong>
                      <Badge status={s.status} />
                      <span>{s.durationMs ?? "—"}ms</span>
                    </div>
                  ))}
                </div>
              </section>
            ),
        )}
      </div>
      {a.data && b.data && (
        <section className="connected-panel section">
          <h2>
            {JSON.stringify(a.data.output) === JSON.stringify(b.data.output)
              ? "Outputs match"
              : "Outputs differ"}
          </h2>
          <p>
            Compared complete recorded JSON outputs. Timing and individual steps are shown above.
          </p>
        </section>
      )}
    </>
  );
}
