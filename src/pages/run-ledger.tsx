import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { ProjectLink as Link } from "../components/project-link";
import { ErrorMessage, Icon } from "../components/product-ui";
import { RUN_STATUSES, type RunStatus } from "../../shared/domain/status";

export function RunLedger({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<RunStatus | "">("");
  const runs = useInfiniteQuery({
    queryKey: ["runs", projectId, status],
    queryFn: ({ pageParam }) =>
      api.runs({
        projectId,
        status: status || undefined,
        cursor: pageParam ?? undefined,
        limit: 25,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 4000,
  });
  const items = runs.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workflow runs</h1>
          <p>
            Inspect workflow steps and recover failed work. Repository test results live in
            Investigations.
          </p>
        </div>
        <div className="actions">
          <button className="btn" disabled={runs.isFetching} onClick={() => void runs.refetch()}>
            <Icon name="arrows-rotate" /> Refresh
          </button>
          {(items.length > 0 || runs.isError) && (
            <Link className="btn primary" to="/workflows">
              <Icon name="play" /> Run a workflow
            </Link>
          )}
        </div>
      </div>
      <div className="content-toolbar">
        <Link className="text-link" to="/investigations">
          Repository test investigations <Icon name="arrow-right" />
        </Link>
        <label>
          Status{" "}
          <select
            aria-label="Execution status"
            value={status}
            onChange={(e) => setStatus(e.target.value as RunStatus | "")}
          >
            <option value="">All statuses</option>
            {RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <Link className="text-link" to="/traces">
          External application traces <Icon name="arrow-right" />
        </Link>
      </div>
      <ErrorMessage error={runs.error} />
      {runs.isPending ? (
        <p role="status">Loading executions…</p>
      ) : items.length ? (
        <div className="compact-stack section">
          {items.map((run) => (
            <Link className="integration-row" to={"/executions/" + run.id} key={run.id}>
              <div>
                <strong>{run.workflow.name}</strong>
                <p className="hint">
                  Version {run.workflow.version} · {new Date(run.createdAt).toLocaleString()}
                </p>
                {run.error && (
                  <p>
                    {run.error.stepKey ? run.error.stepKey + ": " : ""}
                    {run.error.message}
                  </p>
                )}
                <span className="hint">
                  {run.stepCounts.succeeded}/{run.stepCounts.total} steps complete
                  {run.retryOfRunId
                    ? " · Recovery execution"
                    : run.parentRunId
                      ? " · Edited input"
                      : ""}
                </span>
              </div>
              <span className={"status " + run.status.toLowerCase()}>
                {run.status.toLowerCase()}
              </span>
              <Icon name="arrow-right" />
            </Link>
          ))}
          {runs.hasNextPage && (
            <button
              className="btn"
              disabled={runs.isFetchingNextPage}
              onClick={() => void runs.fetchNextPage()}
            >
              {runs.isFetchingNextPage ? "Loading…" : "Load older executions"}
            </button>
          )}
        </div>
      ) : !runs.isError ? (
        <section className="flow-empty">
          <Icon name="play" />
          <h2>{status ? "No executions with this status" : "Run your first workflow"}</h2>
          <p>
            {status
              ? "Choose another status to see more executions."
              : "Create a workflow or choose a template. Its steps and recovery history will appear here. Tests run through your coding agent appear in Investigations."}
          </p>
          {status ? (
            <button className="btn" onClick={() => setStatus("")}>
              Show all statuses
            </button>
          ) : (
            <Link className="btn primary" to="/workflows">
              Open workflows
            </Link>
          )}
        </section>
      ) : null}
    </>
  );
}
