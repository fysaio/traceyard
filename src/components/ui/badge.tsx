import type { HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

type BadgeTone = "neutral" | "success" | "danger" | "warning" | "info" | "accent";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-line-strong bg-raised text-muted",
  success: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  danger: "border-rose-400/25 bg-rose-400/10 text-rose-300",
  warning: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  info: "border-sky-400/25 bg-sky-400/10 text-sky-300",
  accent: "border-accent/30 bg-accent/10 text-accent",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
