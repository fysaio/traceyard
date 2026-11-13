import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/icon";
import { EmptyState, ErrorState } from "../components/empty-state";
import { LaunchDialog } from "../components/launch-dialog";
import { MetricCard } from "../components/metric-card";
import { PageHeader } from "../components/page-header";
import { RunTable } from "../components/run-table";
import { TrendChart } from "../components/trend-chart";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton, SkeletonRows } from "../components/ui/skeleton";
import { api, ApiClientError } from "../lib/api";
import { formatDuration, formatNumber, formatPercent } from "../lib/utils";

export function OverviewPage() {
  const [launchOpen, setLaunchOpen] = useState(false);
  const days = 14;

  const overview = useQuery({
    queryKey: ["overview", days],
    queryFn: () => api.overview(days),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return false;
      return data.totals.queued + data.totals.running + data.totals.cancelling > 0 ? 4_000 : false;
    },
  });
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: api.workflows });
  const session = useQuery({ queryKey: ["auth-session"], queryFn: api.authSession });
  const sandbox = useQuery({ queryKey: ["sandbox"], queryFn: api.sandbox });

  const data = overview.data;
  const hasActivity = data !== undefined && data.totals.runs > 0;

  return (
    <>
      <PageHeader
        eyebrow="Execution intelligence"
        title="Overview"
        description="A live, persisted view of every workflow execution in this anonymous sandbox session. Metrics are computed from D1 — nothing here is simulated."
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh overview"
              onClick={() => void overview.refetch()}
              icon={<Icon name="refresh" className={overview.isFetching ? "animate-spin" : ""} />}
            />
            <Button
              variant="primary"
              icon={<Icon name="play" />}
              onClick={() => setLaunchOpen(true)}
              disabled={workflows.data === undefined || workflows.data.length === 0}
            >
              Launch run
            </Button>
          </>
        }
      />

      <section className="mb-6 grid gap-6 border-y border-line py-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)] lg:gap-10 lg:py-8">
        <div className="flex flex-col items-start">
          <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.18em] text-faint">
            Durable execution, without the guesswork
          </p>
          <h2 className="max-w-2xl text-3xl font-semibold leading-tight tracking-[-0.04em] text-ink sm:text-4xl">
            Follow every run from first step to recovery.
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted">
            Traceyard records workflow progress, attempts, events and outputs so you can inspect
            what happened and retry a failed run with its history intact.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Link
              to="/workflows"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-ink px-4 text-xs font-medium text-canvas no-underline transition-opacity hover:opacity-80"
            >
              Explore sandbox <Icon name="arrow-up-right" className="text-[10px]" />
            </Link>
            {session.data?.user == null && session.data?.githubSignInAvailable !== false ? (
              <a
                href="/api/auth/github/start"
                className="inline-flex h-9 items-center gap-2 rounded-md border border-line-strong px-4 text-xs font-medium text-ink no-underline transition-colors hover:bg-raised"
              >
                <Icon name="github" /> Continue with GitHub
              </a>
            ) : null}
            {session.data?.user == null && session.data?.githubSignInAvailable === false ? (
              <span className="max-w-52 text-[11px] leading-4 text-muted">
                GitHub sign-in is unavailable. Sandbox browsing and launch remain available.
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="play" />}
              onClick={() => setLaunchOpen(true)}
              disabled={workflows.data === undefined || workflows.data.length === 0}
            >
              Start a run
            </Button>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-faint">
            Guest runs are private to this browser session and governed by the live sandbox quota.
            {sandbox.data === undefined
              ? " Quota availability is being checked."
              : ` ${sandbox.data.sessionDailyLimit} runs per session each day; ${sandbox.data.retentionDays}-day retention.`}
          </p>
        </div>

        <div className="border-t border-line pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
                Available to run
              </p>
              <p className="mt-1 text-xs text-muted">Built-in executable workflows</p>
            </div>
            <Link
              to="/workflows"
              className="text-[11px] text-muted underline underline-offset-4 hover:text-ink"
            >
              Full catalog
            </Link>
          </div>
          {workflows.isPending ? (
            <SkeletonRows rows={2} />
          ) : workflows.isError ? (
            <p className="rounded-md border border-line px-3 py-3 text-xs text-muted">
              Workflow catalog unavailable. Existing executions and navigation remain available.
            </p>
          ) : workflows.data?.length === 0 ? (
            <p className="rounded-md border border-line px-3 py-3 text-xs text-muted">
              No executable workflows are available in this deployment.
            </p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {(workflows.data ?? []).slice(0, 3).map((workflow) => (
                <li key={workflow.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{workflow.name}</p>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted">
                      {workflow.description}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-faint">
                    v{workflow.version}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {overview.isError ? (
        <ErrorState
          message={
            overview.error instanceof ApiClientError
              ? overview.error.message
              : "The overview could not be loaded."
          }
          onRetry={() => void overview.refetch()}
        />
      ) : null}

      {hasActivity ? (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard
              label="Total executions"
              value={data === undefined ? "—" : formatNumber(data.totals.runs)}
              hint={
                data === undefined
                  ? "Loading…"
                  : `${data.totals.succeeded} succeeded · ${data.totals.failed} failed`
              }
              icon={<Icon name="activity" className="text-sm" />}
            />
            <MetricCard
              label="Success rate"
              value={data === undefined ? "—" : formatPercent(data.totals.successRate)}
              hint={
                data === undefined
                  ? "Loading…"
                  : data.totals.successRate === null
                    ? "No terminal runs yet"
                    : "Succeeded ÷ terminal runs"
              }
              icon={<Icon name="shield" className="text-sm" />}
              tone="accent"
            />
            <MetricCard
              label="P95 duration"
              value={data === undefined ? "—" : formatDuration(data.executionDuration.p95Ms)}
              hint={
                data === undefined
                  ? "Loading…"
                  : `${data.executionDuration.sampleSize} completed samples`
              }
              icon={<Icon name="timer" className="text-sm" />}
            />
            <MetricCard
              label="In flight"
              value={
                data === undefined
                  ? "—"
                  : formatNumber(data.totals.running + data.totals.queued + data.totals.cancelling)
              }
              hint={
                data === undefined
                  ? "Loading…"
                  : `${data.totals.queued} queued · ${data.totals.running} running · ${data.totals.cancelling} cancelling`
              }
              icon={<Icon name="gauge" className="text-sm" />}
            />
          </section>

          <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader className="flex-row items-start justify-between">
                <div className="flex flex-col gap-1">
                  <CardTitle>Execution volume</CardTitle>
                  <CardDescription>
                    Daily runs over the last {days} days, grouped by terminal outcome.
                  </CardDescription>
                </div>
                <span className="mt-1 font-mono text-[10px] uppercase tracking-wider text-faint">
                  last {days}d
                </span>
              </CardHeader>
              <CardContent>
                {data === undefined ? (
                  <Skeleton className="h-[210px] w-full" />
                ) : (
                  <TrendChart data={data.trend} days={days} />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Sandbox capacity</CardTitle>
                <CardDescription>
                  Quotas are enforced server-side before a run is accepted.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {data === undefined ? (
                  <SkeletonRows rows={4} />
                ) : (
                  <>
                    <QuotaBar
                      label="Session daily runs"
                      used={data.sandbox.sessionRunsToday}
                      limit={data.sandbox.sessionDailyLimit}
                    />
                    <QuotaBar
                      label="Session hourly runs"
                      used={data.sandbox.sessionRunsThisHour}
                      limit={data.sandbox.sessionHourlyLimit}
                    />
                    <QuotaBar
                      label="Global daily runs"
                      used={data.sandbox.globalRunsToday}
                      limit={data.sandbox.globalDailyLimit}
                    />
                    <QuotaBar
                      label="Active concurrency"
                      used={data.sandbox.activeRuns}
                      limit={data.sandbox.activeRunLimit}
                    />
                    <div className="flex items-center justify-between rounded-lg border border-line bg-canvas/50 px-3 py-2.5 text-[11px]">
                      <span className="inline-flex items-center gap-1.5 text-muted">
                        <Icon name="clock" className="text-xs text-faint" />
                        Retention
                      </span>
                      <span className="font-mono text-ink">{data.sandbox.retentionDays} days</span>
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-line bg-canvas/50 px-3 py-2.5 text-[11px]">
                      <span className="inline-flex items-center gap-1.5 text-muted">
                        <Icon name="shield" className="text-xs text-faint" />
                        Circuit breaker
                      </span>
                      <span
                        className={
                          data.sandbox.circuitOpenUntil === null
                            ? "text-muted"
                            : "text-ink font-medium"
                        }
                      >
                        {data.sandbox.circuitOpenUntil === null
                          ? "closed"
                          : `open until ${new Date(data.sandbox.circuitOpenUntil).toLocaleTimeString()}`}
                      </span>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </section>
        </>
      ) : null}

      <section
        className={`mt-4 grid gap-4 ${
          hasActivity ? "xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]" : ""
        }`}
      >
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div className="flex flex-col gap-1">
              <CardTitle>Recent executions</CardTitle>
              <CardDescription>The newest runs created by this session.</CardDescription>
            </div>
            <Link
              to="/executions"
              className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent"
            >
              View all <Icon name="arrow-up-right" className="text-[10px]" />
            </Link>
          </CardHeader>
          <CardContent className="px-0 pb-1">
            {data === undefined ? (
              <div className="px-5">
                <SkeletonRows rows={4} />
              </div>
            ) : data.recentRuns.length === 0 ? (
              <div className="px-5">
                <EmptyState
                  icon={<Icon name="inbox" className="text-sm" />}
                  title="No executions yet"
                  description="Launch an available workflow to create a real run with persisted steps, attempts and events."
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Icon name="play" className="text-[10px]" />}
                      onClick={() => setLaunchOpen(true)}
                      disabled={workflows.data === undefined || workflows.data.length === 0}
                    >
                      Launch first run
                    </Button>
                  }
                />
              </div>
            ) : (
              <RunTable runs={data.recentRuns} />
            )}
          </CardContent>
        </Card>

        {hasActivity ? (
          <Card>
            <CardHeader>
              <CardTitle>Failure classes</CardTitle>
              <CardDescription>
                Classified run failures across the current {days}-day window.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data === undefined ? (
                <SkeletonRows rows={3} />
              ) : data.failureClasses.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-4 py-8 text-center">
                  <Icon name="shield" className="mb-1 text-base text-muted" />
                  <p className="text-xs text-muted">No classified failures in this window.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {data.failureClasses.map((failure) => {
                    const max = Math.max(...data.failureClasses.map((item) => item.count), 1);
                    return (
                      <div key={failure.class} className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-mono text-[11px] text-ink">{failure.class}</span>
                          <span className="font-mono text-[11px] text-muted">{failure.count}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                          <div
                            className="h-full rounded-full bg-ink/65"
                            style={{ width: `${Math.max(6, (failure.count / max) * 100)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}
      </section>

      {hasActivity ? (
        <section className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MiniStat
            label="Median duration"
            value={data === undefined ? "—" : formatDuration(data.executionDuration.p50Ms)}
            loading={data === undefined}
          />
          <MiniStat
            label="Max duration"
            value={data === undefined ? "—" : formatDuration(data.executionDuration.maxMs)}
            loading={data === undefined}
          />
          <MiniStat
            label="Median queue delay"
            value={data === undefined ? "—" : formatDuration(data.queueDelay.p50Ms)}
            loading={data === undefined}
          />
          <MiniStat
            label="Window runs"
            value={data === undefined ? "—" : formatNumber(data.window.runs)}
            loading={data === undefined}
            hint={
              data === undefined
                ? undefined
                : `${data.window.succeeded} succeeded · ${data.window.failed} failed`
            }
          />
        </section>
      ) : null}

      {data !== undefined && data.totals.cancelled > 0 ? (
        <p className="mt-4 inline-flex items-center gap-1.5 text-[11px] text-faint">
          <Icon name="triangle-alert" className="text-xs" />
          {data.totals.cancelled} cancelled run{data.totals.cancelled === 1 ? "" : "s"} retained for
          audit.
        </p>
      ) : null}

      <LaunchDialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        workflows={workflows.data ?? []}
      />
    </>
  );
}

function QuotaBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const ratio = limit <= 0 ? 0 : Math.min(1, used / limit);
  const hot = ratio >= 0.8;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-ink">
          {used}
          <span className="text-faint">/{limit}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-raised">
        <div
          className={hot ? "h-full rounded-full bg-ink" : "h-full rounded-full bg-ink/60"}
          style={{ width: `${Math.max(ratio === 0 ? 0 : 3, ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  loading,
  hint,
}: {
  label: string;
  value: string;
  loading: boolean;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface/60 px-4 py-3">
      <p className="text-[10px] uppercase tracking-[0.16em] text-faint">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-6 w-20" />
      ) : (
        <p className="mt-1 font-mono text-lg text-ink">{value}</p>
      )}
      {hint === undefined ? null : <p className="mt-0.5 text-[10px] text-faint">{hint}</p>}
    </div>
  );
}
