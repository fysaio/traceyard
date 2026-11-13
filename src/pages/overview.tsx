import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowUpRight,
  Clock3,
  Gauge,
  Inbox,
  Play,
  RefreshCw,
  ShieldCheck,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { Link } from "react-router-dom";

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

  const data = overview.data;

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
              icon={
                <RefreshCw className={overview.isFetching ? "size-4 animate-spin" : "size-4"} />
              }
            />
            <Button
              variant="primary"
              icon={<Play className="size-3.5" />}
              onClick={() => setLaunchOpen(true)}
              disabled={workflows.data === undefined || workflows.data.length === 0}
            >
              Launch run
            </Button>
          </>
        }
      />

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

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Total executions"
          value={data === undefined ? "—" : formatNumber(data.totals.runs)}
          hint={
            data === undefined
              ? "Loading…"
              : `${data.totals.succeeded} succeeded · ${data.totals.failed} failed`
          }
          icon={<Activity className="size-4" />}
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
          icon={<ShieldCheck className="size-4" />}
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
          icon={<Timer className="size-4" />}
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
          icon={<Gauge className="size-4" />}
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
                    <Clock3 className="size-3.5 text-faint" />
                    Retention
                  </span>
                  <span className="font-mono text-ink">{data.sandbox.retentionDays} days</span>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-line bg-canvas/50 px-3 py-2.5 text-[11px]">
                  <span className="inline-flex items-center gap-1.5 text-muted">
                    <ShieldCheck className="size-3.5 text-faint" />
                    Circuit breaker
                  </span>
                  <span
                    className={
                      data.sandbox.circuitOpenUntil === null ? "text-emerald-300" : "text-amber-300"
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

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
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
              View all <ArrowUpRight className="size-3.5" />
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
                  icon={<Inbox className="size-4" />}
                  title="No executions yet"
                  description="Launch the document-intelligence workflow to create a real run with persisted steps, attempts and events."
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Play className="size-3.5" />}
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
                <ShieldCheck className="size-5 text-emerald-400/80" />
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
                          className="h-full rounded-full bg-rose-400/70"
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
      </section>

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

      {data !== undefined && data.totals.cancelled > 0 ? (
        <p className="mt-4 inline-flex items-center gap-1.5 text-[11px] text-faint">
          <TriangleAlert className="size-3.5" />
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
          className={
            hot ? "h-full rounded-full bg-amber-400/80" : "h-full rounded-full bg-accent/70"
          }
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
