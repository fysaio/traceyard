import type { ReactNode } from "react";

import { cn } from "../lib/utils";

export function MetricCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  tone?: "default" | "accent";
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-line bg-surface/80 p-4",
        tone === "accent" && "border-line-strong",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">
          {label}
        </span>
        {icon === undefined ? null : <span className="text-faint">{icon}</span>}
      </div>
      <div className="mt-2 font-mono text-2xl font-medium tracking-tight text-ink">{value}</div>
      {hint === undefined ? null : <p className="mt-1 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}
