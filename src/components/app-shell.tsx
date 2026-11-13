import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";

import { Icon } from "./ui/icon";
import { Button } from "./ui/button";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

const NAV_ITEMS = [
  { to: "/", label: "Overview", icon: "activity", end: true },
  { to: "/executions", label: "Executions", icon: "layers" },
  { to: "/workflows", label: "Workflows", icon: "workflow" },
  { to: "/analytics", label: "Analytics", icon: "bar-chart" },
  { to: "/settings", label: "Settings", icon: "settings" },
] as const;

type Theme = "light" | "dark";

export function AppShell() {
  const queryClient = useQueryClient();
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const sandbox = useQuery({
    queryKey: ["sandbox"],
    queryFn: api.sandbox,
  });
  const session = useQuery({ queryKey: ["auth-session"], queryFn: api.authSession });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      await queryClient.cancelQueries();
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: ["auth-session"] });
    },
  });
  const claim = useMutation({
    mutationFn: api.claim,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
        queryClient.invalidateQueries({ queryKey: ["run"] }),
        queryClient.invalidateQueries({ queryKey: ["events"] }),
        queryClient.invalidateQueries({ queryKey: ["analytics"] }),
        queryClient.invalidateQueries({ queryKey: ["sandbox"] }),
      ]);
    },
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),
      );
    try {
      localStorage.setItem("traceyard-theme", theme);
    } catch {
      // Theme still applies for this visit when storage is unavailable.
    }
  }, [theme]);

  const toggleTheme = () => setTheme((current) => (current === "dark" ? "light" : "dark"));

  function claimGuestRuns() {
    if (
      session.data?.user != null &&
      session.data.currentSessionId != null &&
      window.confirm(
        "Claim the executions from this anonymous browser session for your GitHub account? This cannot be undone.",
      )
    ) {
      claim.mutate();
    }
  }

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[244px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-surface lg:flex">
        <NavLink to="/" className="flex items-center gap-3 px-5 py-5 no-underline">
          <div className="flex size-9 items-center justify-center rounded-md border border-line-strong bg-raised text-ink">
            <Icon name="git-branch" className="text-sm" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-bold tracking-tight text-ink">Traceyard</span>
            <span className="text-[10px] uppercase tracking-[0.16em] text-faint">
              execution intelligence
            </span>
          </div>
        </NavLink>

        <nav aria-label="Primary navigation" className="flex flex-1 flex-col gap-1 px-3 py-3">
          <p className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
            Workspace
          </p>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={"end" in item ? item.end : false}
              className={({ isActive }) =>
                cn(
                  "group flex items-center gap-2.5 rounded-md px-2.5 py-2.5 text-sm transition-colors",
                  isActive
                    ? "bg-raised font-medium text-ink"
                    : "text-muted hover:bg-raised hover:text-ink",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    name={item.icon}
                    className={cn("w-4 text-center", isActive ? "text-ink" : "text-faint")}
                  />
                  <span>{item.label}</span>
                  {isActive ? (
                    <span className="ml-auto h-4 w-0.5 rounded-full bg-ink" aria-hidden="true" />
                  ) : null}
                </>
              )}
            </NavLink>
          ))}

          <div className="mt-auto flex flex-col gap-3 px-1 pb-3">
            <div className="rounded-md border border-line bg-canvas p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
                  Sandbox
                </span>
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted">
                  <span className="size-1.5 rounded-sm border border-current" aria-hidden="true" />
                  {sandbox.data === undefined
                    ? sandbox.isError
                      ? "unavailable"
                      : "checking"
                    : sandbox.data.enabled
                      ? "open"
                      : "paused"}
                </span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                {sandbox.data === undefined
                  ? sandbox.isError
                    ? "Quota state is unavailable."
                    : "Checking quota state…"
                  : `${sandbox.data.activeRuns}/${sandbox.data.activeRunLimit} active · ${sandbox.data.sessionRunsToday}/${sandbox.data.sessionDailyLimit} daily runs used`}
              </p>
            </div>

            <div className="flex items-center justify-between px-1 text-[10px] text-faint">
              <span className="inline-flex items-center gap-1.5">
                <Icon name="boxes" className="text-[10px]" />v{health.data?.version ?? "—"}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-sm border border-current" aria-hidden="true" />
                {health.data?.status ?? (health.isError ? "unavailable" : "checking")}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start text-xs"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              onClick={toggleTheme}
              icon={<Icon name={theme === "dark" ? "sun" : "moon"} className="text-xs" />}
            >
              {theme === "dark" ? "Light theme" : "Dark theme"}
            </Button>
          </div>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-canvas lg:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <NavLink to="/" className="flex items-center gap-2 no-underline">
              <div className="flex size-7 items-center justify-center rounded border border-line-strong bg-raised text-ink">
                <Icon name="git-branch" className="text-xs" />
              </div>
              <span className="text-sm font-bold text-ink">Traceyard</span>
            </NavLink>
            <div className="flex items-center gap-1">
              <AuthControls
                session={session.data}
                isLoading={session.isPending}
                isError={session.isError}
                onLogout={() => logout.mutate()}
                onClaim={claimGuestRuns}
                busy={logout.isPending || claim.isPending}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                onClick={toggleTheme}
                icon={<Icon name={theme === "dark" ? "sun" : "moon"} />}
              />
            </div>
          </div>
          <nav aria-label="Primary navigation" className="flex gap-0 overflow-x-auto px-2 pb-2">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={"end" in item ? item.end : false}
                className={({ isActive }) =>
                  cn(
                    "whitespace-nowrap rounded-md px-2 py-1.5 text-xs",
                    isActive ? "bg-raised font-medium text-ink" : "text-muted",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </header>

        <header className="hidden min-h-14 items-center justify-between border-b border-line bg-canvas px-6 lg:flex">
          <span className="text-xs text-muted">
            {sandbox.data === undefined
              ? sandbox.isError
                ? "Sandbox status unavailable"
                : "Checking sandbox availability"
              : sandbox.data.enabled
                ? "Anonymous execution workspace · bounded sandbox"
                : "Sandbox is currently paused"}
          </span>
          <AuthControls
            session={session.data}
            isLoading={session.isPending}
            isError={session.isError}
            onLogout={() => logout.mutate()}
            onClaim={claimGuestRuns}
            busy={logout.isPending || claim.isPending}
          />
        </header>

        {(claim.isError || logout.isError) && (
          <div role="alert" className="border-b border-line bg-raised px-4 py-2 text-xs text-ink">
            {claim.isError
              ? "Guest executions could not be claimed. Please try again."
              : "Sign out failed. Please try again."}
          </div>
        )}
        {claim.isSuccess && (
          <div role="status" className="border-b border-line bg-raised px-4 py-2 text-xs text-ink">
            {claim.data.claimedRuns === 0
              ? "No eligible guest runs were found in this browser session."
              : `Claimed ${claim.data.claimedRuns} guest run${claim.data.claimedRuns === 1 ? "" : "s"} to your account.`}
          </div>
        )}

        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>

        <footer className="border-t border-line px-4 py-4 text-[11px] text-faint sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2">
            <span>Traceyard · execution history built for inspection and recovery.</span>
            <span className="inline-flex items-center gap-1.5">
              <Icon name="circle-help" className="text-[10px]" />
              Sandbox data is session-scoped and expires automatically.
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}

function AuthControls({
  session,
  isLoading,
  isError,
  onLogout,
  onClaim,
  busy,
}: {
  session: Awaited<ReturnType<typeof api.authSession>> | undefined;
  isLoading: boolean;
  isError: boolean;
  onLogout: () => void;
  onClaim: () => void;
  busy: boolean;
}) {
  if (session?.user !== undefined && session.user !== null) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="max-w-28 truncate text-xs text-muted" title={session.user.login}>
          @{session.user.login}
        </span>
        {session.currentSessionId !== null ? (
          <Button
            variant="ghost"
            size="sm"
            className="px-2 text-[11px]"
            onClick={onClaim}
            disabled={busy}
          >
            Claim guest runs
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="px-2 text-[11px]"
          onClick={onLogout}
          disabled={busy}
          icon={<Icon name="x" className="text-[10px]" />}
        >
          Sign out
        </Button>
      </div>
    );
  }

  if (session?.githubSignInAvailable === false) {
    return (
      <span
        role="status"
        className="max-w-56 text-right text-[11px] leading-4 text-muted sm:max-w-none"
      >
        GitHub sign-in is unavailable. Sandbox browsing and launch remain available.
      </span>
    );
  }

  return (
    <a
      href="/api/auth/github/start"
      className="inline-flex min-h-8 items-center gap-2 rounded-md border border-line-strong px-3 text-xs font-medium text-ink no-underline transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      aria-label="Continue with GitHub"
      aria-busy={isLoading}
      title={isError ? "Account status unavailable; GitHub sign-in is still available." : undefined}
    >
      <Icon name="github" className="text-sm" />
      <span className="hidden sm:inline">Continue with GitHub</span>
      <span className="sm:hidden">Sign in</span>
    </a>
  );
}
