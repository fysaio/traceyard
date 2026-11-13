import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  Boxes,
  CircleHelp,
  GitBranch,
  LayoutDashboard,
  Settings,
  Workflow,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

import { api } from "../lib/api";
import { cn } from "../lib/utils";

const NAV_ITEMS = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/executions", label: "Executions", icon: Activity },
  { to: "/workflows", label: "Workflows", icon: Workflow },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell() {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const sandbox = useQuery({
    queryKey: ["sandbox"],
    queryFn: api.sandbox,
    refetchInterval: 20_000,
  });

  const sandboxEnabled = sandbox.data?.enabled ?? true;

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-surface/60 lg:flex">
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="glow-accent flex size-9 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <GitBranch className="size-5" strokeWidth={2.2} />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold tracking-tight">Traceyard</span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-faint">
              execution intelligence
            </span>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
          <p className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-[0.18em] text-faint">
            Workspace
          </p>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  isActive ? "bg-raised text-ink" : "text-muted hover:bg-raised/60 hover:text-ink",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon
                    className={cn("size-4", isActive ? "text-accent" : "text-faint")}
                    strokeWidth={1.9}
                  />
                  <span>{item.label}</span>
                  {isActive ? <span className="ml-auto size-1.5 rounded-full bg-accent" /> : null}
                </>
              )}
            </NavLink>
          ))}

          <div className="mt-auto flex flex-col gap-2 px-1 pb-2">
            <div className="rounded-lg border border-line bg-canvas/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-[0.16em] text-faint">Sandbox</span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider",
                    sandboxEnabled ? "text-emerald-300" : "text-amber-300",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      sandboxEnabled ? "bg-emerald-400 live-dot" : "bg-amber-400",
                    )}
                  />
                  {sandboxEnabled ? "open" : "paused"}
                </span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                {sandbox.data === undefined
                  ? "Checking quota state…"
                  : `${sandbox.data.activeRuns}/${sandbox.data.activeRunLimit} active · ${sandbox.data.sessionRunsToday}/${sandbox.data.sessionDailyLimit} of your daily runs used`}
              </p>
            </div>

            <div className="flex items-center justify-between px-1 text-[10px] text-faint">
              <span className="inline-flex items-center gap-1.5">
                <Boxes className="size-3" />v{health.data?.version ?? "0.1.0"}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    health.data?.status === "ok"
                      ? "bg-emerald-400"
                      : health.data === undefined
                        ? "bg-faint"
                        : "bg-rose-400",
                  )}
                />
                {health.data?.status ?? "checking"}
              </span>
            </div>
          </div>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur lg:hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex size-7 items-center justify-center rounded-md bg-accent text-accent-ink">
                <GitBranch className="size-4" />
              </div>
              <span className="text-sm font-semibold">Traceyard</span>
            </div>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 font-mono text-[10px] uppercase text-muted",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  sandboxEnabled ? "bg-emerald-400" : "bg-amber-400",
                )}
              />
              sandbox {sandboxEnabled ? "open" : "paused"}
            </span>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs",
                    isActive ? "bg-raised text-ink" : "text-muted",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </header>

        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>

        <footer className="border-t border-line px-4 py-4 text-[11px] text-faint sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2">
            <span>
              Traceyard · execution intelligence for workflows, background jobs and AI agents.
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CircleHelp className="size-3" />
              Sandbox data is session-scoped and expires automatically.
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
