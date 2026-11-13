import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Braces,
  Database,
  Fingerprint,
  Gauge,
  KeyRound,
  RefreshCw,
  Server,
  ShieldCheck,
  Timer,
} from "lucide-react";

import { ErrorState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton, SkeletonRows } from "../components/ui/skeleton";
import { api, ApiClientError } from "../lib/api";
import { formatDate, formatDuration } from "../lib/utils";

export function SettingsPage() {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const sandbox = useQuery({
    queryKey: ["sandbox"],
    queryFn: api.sandbox,
    refetchInterval: 20_000,
  });

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Settings & runtime"
        description="Read-only runtime facts for this deployment. Values are sourced from bindings, D1 and live health checks — there are no simulated switches on this page."
        actions={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh runtime facts"
            onClick={() => {
              void health.refetch();
              void sandbox.refetch();
            }}
            icon={<RefreshCw className={health.isFetching ? "size-4 animate-spin" : "size-4"} />}
          />
        }
      />

      {health.isError ? (
        <ErrorState
          message={
            health.error instanceof ApiClientError
              ? health.error.message
              : "Runtime health could not be loaded."
          }
          onRetry={() => void health.refetch()}
        />
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Runtime health</CardTitle>
            <CardDescription>Live check of the Worker and its D1 binding.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {health.data === undefined ? (
              <SkeletonRows rows={4} />
            ) : (
              <>
                <Row
                  label="Status"
                  value={
                    <Badge tone={health.data.status === "ok" ? "success" : "danger"}>
                      {health.data.status}
                    </Badge>
                  }
                />
                <Row label="Environment" value={health.data.environment} />
                <Row label="Version" value={health.data.version} mono />
                <Row
                  label="Database"
                  value={
                    health.data.checks.database.status === "ok"
                      ? `ok · ${formatDuration(health.data.checks.database.latencyMs)}`
                      : "error"
                  }
                  tone={health.data.checks.database.status === "ok" ? "ok" : "bad"}
                />
                <Row label="Queue binding" value={health.data.checks.queue.status} tone="ok" />
                <Row
                  label="Workflow binding"
                  value={health.data.checks.workflow.status}
                  tone="ok"
                />
                <Row label="Checked at" value={formatDate(health.data.timestamp)} />
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sandbox posture</CardTitle>
            <CardDescription>
              Anonymous execution is enabled per deployment and guarded by quotas.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {sandbox.data === undefined ? (
              <SkeletonRows rows={4} />
            ) : (
              <>
                <Row
                  label="Accepting runs"
                  value={
                    <Badge tone={sandbox.data.enabled ? "success" : "warning"}>
                      {sandbox.data.enabled ? "enabled" : "paused"}
                    </Badge>
                  }
                />
                <Row
                  label="Circuit breaker"
                  value={
                    sandbox.data.circuitOpenUntil === null
                      ? "closed"
                      : `open until ${formatDate(sandbox.data.circuitOpenUntil)}`
                  }
                  tone={sandbox.data.circuitOpenUntil === null ? "ok" : "warn"}
                />
                <Row
                  label="Session daily limit"
                  value={`${sandbox.data.sessionRunsToday} / ${sandbox.data.sessionDailyLimit}`}
                  mono
                />
                <Row
                  label="Session hourly limit"
                  value={`${sandbox.data.sessionRunsThisHour} / ${sandbox.data.sessionHourlyLimit}`}
                  mono
                />
                <Row
                  label="Global daily limit"
                  value={`${sandbox.data.globalRunsToday} / ${sandbox.data.globalDailyLimit}`}
                  mono
                />
                <Row
                  label="Concurrency"
                  value={`${sandbox.data.activeRuns} / ${sandbox.data.activeRunLimit}`}
                  mono
                />
                <Row label="Retention" value={`${sandbox.data.retentionDays} days`} mono />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Execution semantics</CardTitle>
            <CardDescription>What Traceyard guarantees, and what it does not.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Fact
              icon={<Database className="size-4" />}
              title="D1 is the system of record"
              description="Runs, steps, attempts, events, outputs and dispatches are written transactionally. A run is accepted only after its full bundle is persisted."
            />
            <Fact
              icon={<Gauge className="size-4" />}
              title="At-least-once dispatch"
              description="Queue delivery and Workflow creation are retried. Duplicate messages are idempotent: the dispatch claim and the workflow instance ID both use the run ID."
            />
            <Fact
              icon={<Timer className="size-4" />}
              title="Cooperative cancellation"
              description="Queued runs cancel immediately. Running runs transition to CANCELLING and stop at the next step checkpoint."
            />
            <Fact
              icon={<ShieldCheck className="size-4" />}
              title="No exactly-once claim for side effects"
              description="Traceyard demonstrates idempotent commits inside D1. External side effects would require their own idempotency keys."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Data & privacy</CardTitle>
            <CardDescription>
              Anonymous, session-scoped execution with strict data minimisation.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Fact
              icon={<KeyRound className="size-4" />}
              title="Hashed session identity"
              description="A 256-bit random bearer token lives in an HttpOnly, SameSite=Lax cookie. Only its SHA-256 hash is persisted."
            />
            <Fact
              icon={<Fingerprint className="size-4" />}
              title="Hashed network metadata"
              description="IP and user-agent are stored only as keyed fingerprints for abuse limits. Raw values are never persisted or logged."
            />
            <Fact
              icon={<Braces className="size-4" />}
              title="Bounded input"
              description="Request bodies are capped at 32 KB and validated against a strict Zod schema before persistence."
            />
            <div className="rounded-lg border border-line bg-canvas/50 p-3">
              <p className="text-[11px] leading-relaxed text-muted">
                Runs are private to the browser session that created them. There is no public
                gallery, cross-session comparison or organisation feature in this build.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>API quickstart</CardTitle>
          <CardDescription>
            The JSON API is the same surface the console uses. Mutations require a same-origin
            browser context, so use the console for anonymous sandbox runs.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-2">
          <CodeSample
            title="Launch a run"
            code={`curl -X POST https://<your-worker>/api/runs \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: 6f1c2e5a-run-0001" \\
  -d '{
    "workflowId": "document-intelligence",
    "scenario": "success",
    "input": {
      "title": "Incident review",
      "document": "A bounded document with at least 24 characters."
    }
  }'`}
          />
          <CodeSample
            title="Inspect persisted state"
            code={`curl https://<your-worker>/api/runs/<runId>
curl "https://<your-worker>/api/runs/<runId>/events?after=0"
curl https://<your-worker>/api/overview?days=14
curl https://<your-worker>/api/analytics?days=14`}
          />
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Deployment</CardTitle>
          <CardDescription>Resources bound to this Worker.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Resource
            icon={<Server className="size-4" />}
            title="Cloudflare Workers"
            detail="Static assets + API"
          />
          <Resource icon={<Database className="size-4" />} title="D1" detail="traceyard-prod-db" />
          <Resource
            icon={<Gauge className="size-4" />}
            title="Queues + Workflows"
            detail="traceyard-executions · 1 class"
          />
        </CardContent>
      </Card>
      {health.data === undefined ? <Skeleton className="mt-4 h-4 w-40" /> : null}
    </>
  );
}

function Row({
  label,
  value,
  mono = false,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  tone?: "default" | "ok" | "warn" | "bad";
}) {
  const toneClass =
    tone === "ok"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "bad"
          ? "text-rose-300"
          : "text-ink";
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/60 pb-2.5 last:border-0 last:pb-0">
      <span className="text-xs text-muted">{label}</span>
      <span className={`text-xs ${mono ? "font-mono" : ""} ${toneClass}`}>{value}</span>
    </div>
  );
}

function Fact({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 text-accent/70">{icon}</span>
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-ink">{title}</span>
        <span className="text-[11px] leading-relaxed text-muted">{description}</span>
      </div>
    </div>
  );
}

function CodeSample({ title, code }: { title: string; code: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.14em] text-faint">{title}</span>
      <pre className="overflow-x-auto rounded-lg border border-line bg-canvas/70 p-3 font-mono text-[10px] leading-relaxed text-muted">
        {code}
      </pre>
    </div>
  );
}

function Resource({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-canvas/40 p-3">
      <span className="text-faint">{icon}</span>
      <div className="flex flex-col">
        <span className="text-xs font-medium text-ink">{title}</span>
        <span className="font-mono text-[10px] text-faint">{detail}</span>
      </div>
    </div>
  );
}
