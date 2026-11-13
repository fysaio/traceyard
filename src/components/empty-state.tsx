import type { ReactNode } from "react";

import { cn } from "../lib/utils";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface/40 px-6 py-14 text-center",
        className,
      )}
    >
      {icon === undefined ? null : (
        <div className="flex size-10 items-center justify-center rounded-lg border border-line bg-raised text-muted">
          {icon}
        </div>
      )}
      <div className="flex max-w-sm flex-col gap-1.5">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <p className="text-xs leading-relaxed text-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-danger/25 bg-danger/5 p-5">
      <p className="text-sm text-danger">{message}</p>
      {onRetry === undefined ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="text-xs font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
        >
          Try again
        </button>
      )}
    </div>
  );
}
