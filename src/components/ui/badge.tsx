import type { HTMLAttributes } from "react";

import { cn } from "../../lib/utils";

type BadgeTone = "neutral" | "success" | "danger" | "warning" | "info" | "accent";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-line-strong bg-raised text-muted",
  success: "border-line-strong bg-raised text-ink",
  danger: "border-line-strong bg-canvas text-ink",
  warning: "border-line-strong bg-raised text-muted",
  info: "border-line-strong bg-canvas text-ink",
  accent: "border-line-strong bg-ink text-canvas",
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
