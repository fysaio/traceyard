import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  Copy,
  ExternalLink,
  Loader2,
  MinusCircle,
  RefreshCw,
  RotateCcw,
  Terminal,
  XCircle,
} from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import type { EventView, RunDetail, StepView } from "../../shared/contracts/api";
import { ErrorState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { StatusBadge } from "../components/status-badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { api, ApiClientError } from "../lib/api";
import { cn, formatDate, formatDuration, formatRelative, shortId } from "../lib/utils";

export function ExecutionDetailPage() {
  const { runId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId),
    enabled: runId.length > 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "QUEUED" || status === "RUNNING" || status === "CANCELLING" ? 2_000 : false;
    },
  });

  const events = useInfiniteQuery({
    queryKey: ["events", runId],
    queryFn: ({ pageParam }) => api.events(runId, pageParam),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextCursor,
    enabled: runId.length > 0,
    refetchInterval: (query) => {
      const status = query.state.data?.pages[0] === undefined ? undefined : run.data?.status;
      return status === "QUEUED" || status === "RUNNING" || status === "CANCELLING" ? 2_000 : false;
    },
  });

  const cancel = useMutation({
    mutationFn: () => api.cancel(runId),
    onSuccess: (result) => {
      setActionError(null);
      setActionMessage(result.message);
      void queryClient.invalidateQueries({ queryKey: ["run", runId] });
      void queryClient.invalidateQueries({ queryKey: ["events", runId] });
    },
    onError: (error) => {
      setActionMessage(null);
      setActionError(error instanceof ApiClientError ? error.message : "Cancellation failed.");
    },
  });

  const retry = useMutation({
    mutationFn: () => api.retry(runId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      navigate(`/executions/${result.run.id}`);
    },
    onError: (error) => {
      setActionMessage(null);
      setActionError(error instanceof ApiClientError ? error.message : "Retry failed.");
    },
  });

  const data = run.data;
  const terminalStatus = data?.status;
  const { refetch: refetchEvents } = events;
  const eventItems = dedupeEvents(events.data?.pages.flatMap((page) => page.items) ?? []);
  const refetchedTerminal = useRef<string | null>(null);

  // The event query stops polling as soon as the run leaves an active state.
  // If the terminal status is observed before the final event poll lands, fetch
  // the durable event stream once more so the terminal event is never missed.
  useEffect(() => {
    if (
      terminalStatus !== "SUCCEEDED" &&
      terminalStatus !== "FAILED" &&
      terminalStatus !== "CANCELLED"
    ) {
      return;
    }
    if (refetchedTerminal.current === terminalStatus) return;
    refetchedTerminal.current = terminalStatus;
    void refetchEvents();
  }, [terminalStatus, refetchEvents]);

  const canCancel = data !== undefined && (data.status === "QUEUED" || data.status === "RUNNING");
  const canRetry = data !== undefined && data.status === "FAILED" && data.retryRunId === null;
  const replayed = searchParams.get("replayed") === "1";

  return (
    <>
      <Link
        to="/executions"
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink"
      >
        <ArrowLeft className="size-3.5" /> Back to executions
      </Link>

      <PageHeader
        eyebrow={
          data === undefined ? "Execution" : `${data.workflow.name} · v${data.workflow.version}`
        }
        title={data === undefined ? "Loading execution…" : shortId(data.id)}
        description={
          data === undefined
            ? undefined
            : `Created ${formatRelative(data.createdAt)} · ${data.triggerSource} trigger · scenario ${data.scenario}`
        }
        actions={
          <>
            {data === undefined ? null : <StatusBadge status={data.status} />}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh execution"
              onClick={() => {
                void run.refetch();
                void events.refetch();
              }}
              icon={<RefreshCw className={run.isFetching ? "size-4 animate-spin" : "size-4"} />}
            />
            {canCancel ? (
              <Button
                variant="danger"
                icon={<Ban className="size-3.5" />}
                loading={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel
              </Button>
            ) : null}
            {canRetry ? (
              <Button
                variant="primary"
                icon={<RotateCcw className="size-3.5" />}
                loading={retry.isPending}
                onClick={() => retry.mutate()}
              >
                Retry run
              </Button>
            ) : null}
          </>
        }
      />

      {replayed ? (
        <div className="mb-4 rounded-lg border border-sky-400/25 bg-sky-400/5 px-4 py-2.5 text-xs text-sky-200">
          Idempotency key matched an existing request. The original run was returned instead of
          creating a duplicate.
        </div>
      ) : null}

      {actionError === null ? null : (
        <div className="mb-4 rounded-lg border border-danger/25 bg-danger/5 px-4 py-2.5 text-xs text-danger">
          {actionError}
        </div>
      )}
      {actionMessage === null ? null : (
        <div className="mb-4 rounded-lg border border-line-strong bg-raised px-4 py-2.5 text-xs text-muted">
          {actionMessage}
        </div>
      )}

      {run.isError ? (
        <ErrorState
          message={
            run.error instanceof ApiClientError
              ? run.error.message
              : "The execution could not be loaded."
          }
          onRetry={() => void run.refetch()}
        />
      ) : null}

      {data === undefined ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-40 lg:col-span-2" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <>
          {data.error === null ? null : (
            <Card className="mb-4 border-danger/30 bg-danger/5">
              <CardContent className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <XCircle className="size-4 text-danger" />
                  <span className="text-sm font-medium text-danger">{data.error.message}</span>
                </div>
                <div className="flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-wider text-muted">
                  <span>class: {data.error.class}</span>
                  <span>code: {data.error.code}</span>
                  <span>retryable: {String(data.error.retryable)}</span>
                  {data.error.stepKey === undefined ? null : (
                    <span>step: {data.error.stepKey}</span>
                  )}
                  {data.error.attempt === undefined ? null : (
                    <span>attempt: {data.error.attempt}</span>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Execution summary</CardTitle>
                  <CardDescription>
                    Durable state transitions, timing and dispatch evidence.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
                  <Detail label="Run ID" value={data.id} mono />
                  <Detail label="Correlation ID" value={data.correlationId} mono />
                  <Detail label="Trigger" value={data.triggerSource} />
                  <Detail label="Created" value={formatDate(data.createdAt)} />
                  <Detail label="Started" value={formatDate(data.startedAt)} />
                  <Detail label="Completed" value={formatDate(data.completedAt)} />
                  <Detail label="Duration" value={formatDuration(data.durationMs)} mono />
                  <Detail label="Queue delay" value={formatDuration(data.queueDelayMs)} mono />
                  <Detail
                    label="Dispatch"
                    value={`${data.dispatch.status} · ${data.dispatch.attempts} attempt${data.dispatch.attempts === 1 ? "" : "s"}`}
                    mono
                  />
                  <Detail
                    label="Steps"
                    value={`${data.stepCounts.succeeded} succeeded · ${data.stepCounts.failed} failed · ${data.stepCounts.pending + data.stepCounts.running} open`}
                  />
                  <Detail
                    label="Retry lineage"
                    value={
                      data.retryOfRunId === null
                        ? data.retryRunId === null
                          ? "original run"
                          : "retry created"
                        : `retry of ${shortId(data.retryOfRunId)}`
                    }
                  />
                  <Detail
                    label="Cancel requested"
                    value={
                      data.cancelRequestedAt === null ? "no" : formatDate(data.cancelRequestedAt)
                    }
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Step timeline</CardTitle>
                  <CardDescription>
                    Each step is a durable checkpoint. Retries are recorded as individual attempts.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {data.steps.map((step, index) => (
                    <StepTimeline
                      key={step.id}
                      step={step}
                      isLast={index === data.steps.length - 1}
                    />
                  ))}
                </CardContent>
              </Card>

              <div className="grid gap-4 lg:grid-cols-2">
                <JsonCard title="Persisted input" value={data.input} />
                <JsonCard title="Committed output" value={data.output} />
              </div>
            </div>

            <Card className="h-fit xl:sticky xl:top-6">
              <CardHeader className="flex-row items-center justify-between">
                <div className="flex flex-col gap-1">
                  <CardTitle>Event stream</CardTitle>
                  <CardDescription>
                    Product events persisted with the run.{" "}
                    {canCancel ? "Polling every 2s." : "Terminal state."}
                  </CardDescription>
                </div>
                <Terminal className="size-4 text-faint" />
              </CardHeader>
              <CardContent className="px-0">
                {events.isPending ? (
                  <div className="flex flex-col gap-2 px-5">
                    <Skeleton className="h-10" />
                    <Skeleton className="h-10" />
                    <Skeleton className="h-10" />
                  </div>
                ) : eventItems.length === 0 ? (
                  <p className="px-5 py-6 text-xs text-muted">No events recorded.</p>
                ) : (
                  <ul className="max-h-[640px] overflow-y-auto">
                    {eventItems.map((event) => (
                      <EventRow key={event.seq} event={event} />
                    ))}
                  </ul>
                )}
                {events.hasNextPage ? (
                  <div className="flex justify-center px-5 pt-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={events.isFetchingNextPage}
                      onClick={() => void events.fetchNextPage()}
                    >
                      Load more events
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</span>
      <span className={cn("truncate text-xs text-ink", mono && "font-mono")} title={value}>
        {value}
      </span>
    </div>
  );
}

const STEP_ICON = {
  PENDING: Circle,
  RUNNING: Loader2,
  SUCCEEDED: CheckCircle2,
  FAILED: XCircle,
  SKIPPED: MinusCircle,
  CANCELLED: Ban,
} as const;

const STEP_COLOR = {
  PENDING: "text-faint",
  RUNNING: "text-sky-300",
  SUCCEEDED: "text-emerald-300",
  FAILED: "text-rose-300",
  SKIPPED: "text-faint",
  CANCELLED: "text-muted",
} as const;

function StepTimeline({ step, isLast }: { step: StepView; isLast: boolean }) {
  const Icon = STEP_ICON[step.status];
  return (
    <div className="relative flex gap-3">
      {isLast ? null : (
        <span
          className="absolute left-[11px] top-7 h-[calc(100%-8px)] w-px bg-line"
          aria-hidden="true"
        />
      )}
      <div className="relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-canvas">
        <Icon
          className={cn(
            "size-3.5",
            STEP_COLOR[step.status],
            step.status === "RUNNING" && "animate-spin",
          )}
        />
      </div>
      <details className="group min-w-0 flex-1 rounded-lg border border-line bg-canvas/40">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2.5">
          <span className="font-mono text-[10px] text-faint">
            {String(step.ordinal).padStart(2, "0")}
          </span>
          <span className="text-xs font-medium text-ink">{step.name}</span>
          <StatusBadge status={step.status} />
          <span className="ml-auto flex items-center gap-3 font-mono text-[10px] text-faint">
            <span>
              {step.attemptCount}/{step.maxAttempts} attempts
            </span>
            <span>{formatDuration(step.durationMs)}</span>
            <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="flex flex-col gap-3 border-t border-line px-3 py-3">
          <div className="flex flex-wrap gap-4 font-mono text-[10px] text-muted">
            <span>key: {step.key}</span>
            <span>started: {formatDate(step.startedAt)}</span>
            <span>completed: {formatDate(step.completedAt)}</span>
          </div>

          {step.error === null ? null : (
            <div className="rounded-md border border-danger/25 bg-danger/5 px-3 py-2">
              <p className="text-xs text-danger">{step.error.message}</p>
              <p className="mt-1 font-mono text-[10px] text-muted">
                {step.error.class} · {step.error.code} · retryable={String(step.error.retryable)}
              </p>
            </div>
          )}

          {step.attempts.length === 0 ? (
            <p className="text-[11px] text-faint">No attempts recorded.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-left">
                <thead>
                  <tr className="text-[9px] uppercase tracking-wider text-faint">
                    <th className="py-1 pr-3 font-medium">Attempt</th>
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 pr-3 font-medium">Duration</th>
                    <th className="py-1 font-medium">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {step.attempts.map((attempt) => (
                    <tr key={attempt.number} className="border-t border-line/60 align-top">
                      <td className="py-1.5 pr-3 font-mono text-[10px] text-muted">
                        #{attempt.number}
                      </td>
                      <td className="py-1.5 pr-3">
                        <StatusBadge status={attempt.status} />
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-[10px] text-muted">
                        {formatDuration(attempt.durationMs)}
                      </td>
                      <td className="py-1.5 text-[10px] text-muted">
                        {attempt.error === null
                          ? "—"
                          : `${attempt.error.code}: ${attempt.error.message}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {step.output === null ? null : (
            <JsonBlock label="Step output" value={step.output} compact />
          )}
        </div>
      </details>
    </div>
  );
}

function EventRow({ event }: { event: EventView }) {
  const tone =
    event.level === "error"
      ? "bg-rose-400"
      : event.level === "warn"
        ? "bg-amber-400"
        : "bg-sky-400";
  return (
    <li className="border-b border-line/60 px-5 py-2.5 last:border-0">
      <div className="flex items-start gap-2.5">
        <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", tone)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-[10px] text-accent/80">{event.type}</span>
            <span className="shrink-0 font-mono text-[9px] text-faint">
              {new Date(event.createdAt).toLocaleTimeString()}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{event.message}</p>
          {event.stepKey === null && event.attemptNumber === null ? null : (
            <p className="mt-0.5 font-mono text-[9px] text-faint">
              {event.stepKey ?? ""}
              {event.attemptNumber === null ? "" : ` · attempt ${event.attemptNumber}`}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function JsonCard({ title, value }: { title: string; value: unknown }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(value, null, 2) ?? "null";

  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-faint hover:bg-raised hover:text-ink"
        >
          <Copy className="size-3" />
          {copied ? "copied" : "copy"}
        </button>
      </CardHeader>
      <CardContent>
        <pre className="max-h-72 overflow-auto rounded-lg border border-line bg-canvas/70 p-3 font-mono text-[10px] leading-relaxed text-muted">
          {json}
        </pre>
      </CardContent>
    </Card>
  );
}

function JsonBlock({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: unknown;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-wider text-faint">{label}</span>
      <pre
        className={cn(
          "overflow-auto rounded-md border border-line bg-canvas/70 p-2 font-mono text-[10px] leading-relaxed text-muted",
          compact ? "max-h-40" : "max-h-72",
        )}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function dedupeEvents(events: EventView[]): EventView[] {
  const seen = new Set<number>();
  const result: EventView[] = [];
  for (const event of events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    result.push(event);
  }
  return result.sort((left, right) => left.seq - right.seq);
}

export function ExecutionLink({ id }: { id: string }) {
  return (
    <Link
      to={`/executions/${id}`}
      className="inline-flex items-center gap-1 text-accent hover:underline"
    >
      {shortId(id)} <ExternalLink className="size-3" />
    </Link>
  );
}

export function RunStateIcon({ status }: { status: RunDetail["status"] }) {
  const Icon =
    status === "SUCCEEDED"
      ? CheckCircle2
      : status === "FAILED"
        ? XCircle
        : status === "CANCELLED"
          ? Ban
          : status === "RUNNING"
            ? Loader2
            : Clock3;
  return <Icon className="size-4" />;
}
