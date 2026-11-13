import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";

import type { RunSummary } from "../../shared/contracts/api";
import { formatDuration, formatRelative, shortId } from "../lib/utils";
import { StatusBadge } from "./status-badge";

export function RunTable({ runs }: { runs: RunSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line text-[10px] uppercase tracking-[0.14em] text-faint">
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Execution</th>
            <th className="px-4 py-2.5 font-medium">Workflow</th>
            <th className="px-4 py-2.5 font-medium">Steps</th>
            <th className="px-4 py-2.5 font-medium">Duration</th>
            <th className="px-4 py-2.5 font-medium">Queue</th>
            <th className="px-4 py-2.5 font-medium">Created</th>
            <th className="w-8 px-2 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const finished = run.stepCounts.succeeded + run.stepCounts.failed;
            return (
              <tr
                key={run.id}
                className="group border-b border-line/70 transition-colors last:border-0 hover:bg-raised/60"
              >
                <td className="px-4 py-3">
                  <StatusBadge status={run.status} />
                </td>
                <td className="px-4 py-3">
                  <Link
                    to={`/executions/${run.id}`}
                    className="font-mono text-xs text-ink underline-offset-4 hover:text-accent hover:underline"
                  >
                    {shortId(run.id)}
                  </Link>
                  <div className="mt-0.5 text-[10px] uppercase tracking-wider text-faint">
                    {run.triggerSource}
                    {run.retryOfRunId === null ? "" : " · retry"}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="text-xs text-ink">{run.workflow.name}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-faint">
                    v{run.workflow.version} · {run.scenario}
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted">
                  {finished}/{run.stepCounts.total}
                  {run.stepCounts.failed > 0 ? (
                    <span className="ml-1.5 text-rose-300">·{run.stepCounts.failed} failed</span>
                  ) : null}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted">
                  {formatDuration(run.durationMs)}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-faint">
                  {formatDuration(run.queueDelayMs)}
                </td>
                <td className="px-4 py-3 text-xs text-muted">{formatRelative(run.createdAt)}</td>
                <td className="px-2 py-3">
                  <Link
                    to={`/executions/${run.id}`}
                    aria-label={`Open ${run.id}`}
                    className="flex size-7 items-center justify-center rounded-md text-faint transition-colors group-hover:bg-raised group-hover:text-ink"
                  >
                    <ChevronRight className="size-4" />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
