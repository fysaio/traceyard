import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-col gap-1.5">
        {eyebrow === undefined ? null : (
          <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-accent/80">
            {eyebrow}
          </span>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">{title}</h1>
        {description === undefined ? null : (
          <p className="max-w-2xl text-sm leading-relaxed text-muted">{description}</p>
        )}
      </div>
      {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
