import { Link } from "react-router-dom";

import type { TrendPoint } from "../../shared/contracts/api";

export function TrendChart({ data, days }: { data: TrendPoint[]; days: number }) {
  if (!data.some((point) => point.total > 0)) {
    return (
      <div className="flex min-h-44 flex-col items-center justify-center px-4 text-center">
        <p className="text-sm font-medium text-ink">No execution data in this window</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">
          This chart fills from persisted runs. Launch a real workflow to see the daily volume.
        </p>
        <Link
          to="/workflows"
          className="mt-3 text-xs font-medium text-ink underline underline-offset-4 hover:text-muted"
        >
          Explore executable workflows
        </Link>
      </div>
    );
  }

  const max = Math.max(1, ...data.map((point) => point.total));
  const labelEvery = Math.max(1, Math.ceil(days / 7));
  const gridValues = [...new Set([max, Math.ceil(max / 2), 0])];

  return (
    <div className="w-full">
      <div
        role="list"
        aria-label={`Daily execution volume for the last ${days} days`}
        className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2"
      >
        <div
          aria-hidden="true"
          className="flex h-40 flex-col justify-between pb-px text-right font-mono text-[10px] text-faint"
        >
          {gridValues.map((value) => (
            <span key={value}>{value}</span>
          ))}
        </div>
        <div className="relative min-w-0">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex h-40 flex-col justify-between"
          >
            {gridValues.map((value, index) => (
              <div key={`${value}-${index}`} className="border-t border-dashed border-line" />
            ))}
          </div>
          <div className="relative flex h-40 items-end justify-around border-b border-line">
            {data.map((point, index) => {
              const active = Math.max(
                0,
                point.total - point.succeeded - point.failed - point.cancelled,
              );
              const label = point.date.slice(5).replace("-", "/");

              return (
                <div
                  key={point.date}
                  role="listitem"
                  aria-label={`${point.date}: ${point.total} total, ${point.succeeded} succeeded, ${point.failed} failed, ${point.cancelled} cancelled, ${active} active or queued`}
                  className="flex h-full min-w-0 flex-1 items-end justify-center"
                >
                  {point.total > 0 ? (
                    <div
                      aria-hidden="true"
                      className="flex w-[min(60%,1.5rem)] flex-col-reverse overflow-hidden rounded-t-sm"
                      style={{ height: `${(point.total / max) * 100}%` }}
                    >
                      <Segment
                        count={point.succeeded}
                        total={point.total}
                        color="var(--chart-succeeded)"
                      />
                      <Segment
                        count={point.failed}
                        total={point.total}
                        color="var(--chart-failed)"
                      />
                      <Segment
                        count={point.cancelled}
                        total={point.total}
                        color="var(--chart-cancelled)"
                      />
                      <Segment count={active} total={point.total} color="var(--chart-active)" />
                    </div>
                  ) : null}
                  {index % labelEvery === 0 || index === data.length - 1 ? (
                    <span className="sr-only">{label}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div aria-hidden="true" className="flex h-6 justify-around">
            {data.map((point, index) => (
              <span
                key={point.date}
                className="min-w-0 flex-1 truncate pt-1 text-center font-mono text-[9px] text-faint"
              >
                {index % labelEvery === 0 || index === data.length - 1
                  ? point.date.slice(5).replace("-", "/")
                  : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-muted">
        <Legend color="var(--chart-succeeded)" label="Succeeded" />
        <Legend color="var(--chart-failed)" label="Failed" />
        <Legend color="var(--chart-cancelled)" label="Cancelled" />
        <Legend color="var(--chart-active)" label="Active / queued" />
      </div>
    </div>
  );
}

function Segment({ count, total, color }: { count: number; total: number; color: string }) {
  return count > 0 ? (
    <div
      className="shrink-0"
      style={{ height: `${(count / total) * 100}%`, backgroundColor: color }}
    />
  ) : null;
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
