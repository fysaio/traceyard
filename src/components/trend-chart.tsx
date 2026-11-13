import type { TrendPoint } from "../../shared/contracts/api";

const WIDTH = 760;
const HEIGHT = 210;
const PADDING = { top: 16, right: 12, bottom: 26, left: 34 };

export function TrendChart({ data, days }: { data: TrendPoint[]; days: number }) {
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const max = Math.max(1, ...data.map((point) => point.total));
  const slot = plotWidth / Math.max(1, data.length);
  const barWidth = Math.max(3, Math.min(26, slot * 0.52));
  const labelEvery = Math.max(1, Math.ceil(days / 7));

  const gridValues = [...new Set([0, Math.ceil(max / 2), max])];

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Daily execution volume for the last ${days} days`}
        className="h-auto w-full"
      >
        <defs>
          <linearGradient id="bar-succeeded" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0.35" />
          </linearGradient>
          <linearGradient id="bar-failed" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fb7185" />
            <stop offset="100%" stopColor="#fb7185" stopOpacity="0.35" />
          </linearGradient>
        </defs>

        {gridValues.map((value) => {
          const y = PADDING.top + plotHeight - (value / max) * plotHeight;
          return (
            <g key={value}>
              <line
                x1={PADDING.left}
                x2={WIDTH - PADDING.right}
                y1={y}
                y2={y}
                stroke="#1d222a"
                strokeDasharray={value === 0 ? undefined : "3 4"}
              />
              <text x={PADDING.left - 8} y={y + 3} textAnchor="end" fontSize="9" fill="#5a6472">
                {value}
              </text>
            </g>
          );
        })}

        {data.map((point, index) => {
          const center = PADDING.left + slot * index + slot / 2;
          const base = PADDING.top + plotHeight;
          const succeededHeight = (point.succeeded / max) * plotHeight;
          const failedHeight = (point.failed / max) * plotHeight;
          const cancelledHeight = (point.cancelled / max) * plotHeight;
          const other = Math.max(0, point.total - point.succeeded - point.failed - point.cancelled);
          const otherHeight = (other / max) * plotHeight;
          const label = point.date.slice(5).replace("-", "/");

          return (
            <g key={point.date}>
              <title>
                {point.date}: {point.total} total · {point.succeeded} succeeded · {point.failed}{" "}
                failed
              </title>
              {succeededHeight > 0 ? (
                <rect
                  x={center - barWidth / 2}
                  y={base - succeededHeight}
                  width={barWidth}
                  height={succeededHeight}
                  rx={2}
                  fill="url(#bar-succeeded)"
                />
              ) : null}
              {failedHeight > 0 ? (
                <rect
                  x={center - barWidth / 2}
                  y={base - succeededHeight - failedHeight}
                  width={barWidth}
                  height={failedHeight}
                  rx={2}
                  fill="url(#bar-failed)"
                />
              ) : null}
              {cancelledHeight > 0 ? (
                <rect
                  x={center - barWidth / 2}
                  y={base - succeededHeight - failedHeight - cancelledHeight}
                  width={barWidth}
                  height={cancelledHeight}
                  rx={2}
                  fill="#52525b"
                />
              ) : null}
              {otherHeight > 0 ? (
                <rect
                  x={center - barWidth / 2}
                  y={base - succeededHeight - failedHeight - cancelledHeight - otherHeight}
                  width={barWidth}
                  height={otherHeight}
                  rx={2}
                  fill="#60a5fa"
                  opacity={0.7}
                />
              ) : null}
              {index % labelEvery === 0 || index === data.length - 1 ? (
                <text x={center} y={HEIGHT - 8} textAnchor="middle" fontSize="9" fill="#5a6472">
                  {label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-muted">
        <Legend color="#34d399" label="Succeeded" />
        <Legend color="#fb7185" label="Failed" />
        <Legend color="#52525b" label="Cancelled" />
        <Legend color="#60a5fa" label="Active / queued" />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
