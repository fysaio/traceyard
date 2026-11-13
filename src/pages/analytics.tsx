import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ErrorState } from "../components/empty-state";
import { MetricCard } from "../components/metric-card";
import { PageHeader } from "../components/page-header";
import { TrendChart } from "../components/trend-chart";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Select } from "../components/ui/input";
import { Skeleton, SkeletonRows } from "../components/ui/skeleton";
import { Icon } from "../components/ui/icon";
import { api, ApiClientError } from "../lib/api";
import { formatDuration, formatNumber, formatPercent } from "../lib/utils";

const RANGES = [7, 14, 30];

export function AnalyticsPage() {
  const [days, setDays] = useState(14);
  const analytics = useQuery({
    queryKey: ["analytics", days],
    queryFn: () => api.analytics(days),
  });

  const data = analytics.data;

  return (
    <>
      <PageHeader
        eyebrow="Analytics"
        title="Reliability analytics"
        description="Percentiles, throughput and failure classes computed from persisted execution records. Small sample sizes are shown as-is, never extrapolated."
        actions={
          <>
            <Select
              value={String(days)}
              onChange={(event) => setDays(Number(event.target.value))}
              className="w-auto text-xs"
              aria-label="Analytics window"
            >
              {RANGES.map((range) => (
                <option key={range} value={range}>
                  Last {range} days
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh analytics"
              onClick={() => void analytics.refetch()}
              icon={<Icon name="refresh" className={analytics.isFetching ? "animate-spin" : ""} />}
            />
          </>
        }
      />

      {analytics.isError ? (
        <ErrorState
          message={
            analytics.error instanceof ApiClientError
              ? analytics.error.message
              : "Analytics could not be loaded."
          }
          onRetry={() => void analytics.refetch()}
        />
      ) : null}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Throughput / day"
          value={data === undefined ? "—" : formatNumber(data.throughputPerDay, 2)}
          hint={`${data?.windowDays ?? days}-day average`}
          icon={<Icon name="trending" />}
        />
        <MetricCard
          label="Success rate"
          value={data === undefined ? "—" : formatPercent(data.totals.successRate)}
          hint="All terminal runs in session"
          icon={<Icon name="shield" />}
          tone="accent"
        />
        <MetricCard
          label="Run P95"
          value={data === undefined ? "—" : formatDuration(data.executionDuration.p95Ms)}
          hint={data === undefined ? undefined : `${data.executionDuration.sampleSize} samples`}
          icon={<Icon name="timer" />}
        />
        <MetricCard
          label="Total executions"
          value={data === undefined ? "—" : formatNumber(data.totals.runs)}
          hint={`${data?.totals.succeeded ?? 0} succeeded · ${data?.totals.failed ?? 0} failed`}
          icon={<Icon name="activity" />}
        />
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Volume by outcome</CardTitle>
            <CardDescription>Daily execution counts over the selected window.</CardDescription>
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
            <CardTitle>Duration distribution</CardTitle>
            <CardDescription>
              Completed runs only. Queue delay is measured separately.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {data === undefined ? (
              <SkeletonRows rows={4} />
            ) : (
              <>
                <StatRow label="Average" value={formatDuration(data.executionDuration.avgMs)} />
                <StatRow
                  label="Median · P50"
                  value={formatDuration(data.executionDuration.p50Ms)}
                />
                <StatRow label="Tail · P95" value={formatDuration(data.executionDuration.p95Ms)} />
                <StatRow label="Maximum" value={formatDuration(data.executionDuration.maxMs)} />
                <div className="my-1 border-t border-line" />
                <StatRow label="Queue P50" value={formatDuration(data.queueDelay.p50Ms)} muted />
                <StatRow label="Queue P95" value={formatDuration(data.queueDelay.p95Ms)} muted />
                <p className="text-[10px] text-faint">
                  {data.executionDuration.sampleSize} completed run
                  {data.executionDuration.sampleSize === 1 ? "" : "s"} in sample.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Failure classes</CardTitle>
            <CardDescription>
              Failures are classified by the engine at the point of failure.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data === undefined ? (
              <SkeletonRows rows={3} />
            ) : data.failureClasses.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-line px-4 py-8 text-xs text-muted">
                <Icon name="shield" className="text-sm text-muted" />
                No classified failures in this window.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {data.failureClasses.map((failure) => {
                  const max = Math.max(...data.failureClasses.map((item) => item.count), 1);
                  return (
                    <div key={failure.class} className="flex items-center gap-3">
                      <span className="w-48 shrink-0 font-mono text-[11px] text-ink">
                        {failure.class}
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-raised">
                        <div
                          className="h-full rounded-full bg-ink/65"
                          style={{ width: `${Math.max(4, (failure.count / max) * 100)}%` }}
                        />
                      </div>
                      <span className="w-8 text-right font-mono text-[11px] text-muted">
                        {failure.count}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Step latency</CardTitle>
            <CardDescription>
              P50 and P95 per completed step, aggregated across runs.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data === undefined ? (
              <SkeletonRows rows={4} />
            ) : data.stepDurations.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-line px-4 py-8 text-xs text-muted">
                <Icon name="bar-chart" className="text-sm text-faint" />
                No completed steps yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-left">
                  <thead>
                    <tr className="border-b border-line text-[9px] uppercase tracking-[0.14em] text-faint">
                      <th className="py-2 pr-3 font-medium">Step</th>
                      <th className="py-2 pr-3 font-medium">Samples</th>
                      <th className="py-2 pr-3 font-medium">P50</th>
                      <th className="py-2 font-medium">P95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stepDurations.map((step) => (
                      <tr key={step.stepKey} className="border-b border-line/60 last:border-0">
                        <td className="py-2.5 pr-3">
                          <div className="text-xs text-ink">{step.name}</div>
                          <div className="font-mono text-[9px] text-faint">{step.stepKey}</div>
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-[11px] text-muted">
                          {step.sampleSize}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-[11px] text-muted">
                          {formatDuration(step.p50Ms)}
                        </td>
                        <td className="py-2.5 font-mono text-[11px] text-muted">
                          {formatDuration(step.p95Ms)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>Quota consumption</CardTitle>
            <CardDescription>
              Server-side counters for this session and the shared sandbox.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {data === undefined ? (
              <SkeletonRows rows={2} />
            ) : (
              <>
                <Quota
                  label="Session · today"
                  used={data.sandbox.sessionRunsToday}
                  limit={data.sandbox.sessionDailyLimit}
                />
                <Quota
                  label="Session · this hour"
                  used={data.sandbox.sessionRunsThisHour}
                  limit={data.sandbox.sessionHourlyLimit}
                />
                <Quota
                  label="Global · today"
                  used={data.sandbox.globalRunsToday}
                  limit={data.sandbox.globalDailyLimit}
                />
                <Quota
                  label="Active runs"
                  used={data.sandbox.activeRuns}
                  limit={data.sandbox.activeRunLimit}
                />
              </>
            )}
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function StatRow({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className={muted ? "text-xs text-faint" : "text-xs text-muted"}>{label}</span>
      <span className={muted ? "font-mono text-sm text-muted" : "font-mono text-sm text-ink"}>
        {value}
      </span>
    </div>
  );
}

function Quota({ label, used, limit }: { label: string; used: number; limit: number }) {
  const ratio = limit <= 0 ? 0 : Math.min(1, used / limit);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-canvas/40 p-3">
      <span className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</span>
      <span className="font-mono text-lg text-ink">
        {used}
        <span className="text-sm text-faint">/{limit}</span>
      </span>
      <div className="h-1.5 overflow-hidden rounded-full bg-raised">
        <div
          className={ratio >= 0.8 ? "h-full bg-ink" : "h-full bg-ink/60"}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}
