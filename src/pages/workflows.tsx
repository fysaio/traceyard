import type { ReactNode } from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Code2, Play, RefreshCw, Workflow as WorkflowIcon } from "lucide-react";

import { ErrorState } from "../components/empty-state";
import { LaunchDialog } from "../components/launch-dialog";
import { PageHeader } from "../components/page-header";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { api, ApiClientError } from "../lib/api";
import { formatDuration } from "../lib/utils";

export function WorkflowsPage() {
  const [launchOpen, setLaunchOpen] = useState(false);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | undefined>(undefined);
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: api.workflows });

  return (
    <>
      <PageHeader
        eyebrow="Catalog"
        title="Workflows"
        description="Executable workflows are compiled into this Worker. The D1 catalog supplies metadata and step manifests; a database row alone can never introduce arbitrary code."
        actions={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh workflows"
            onClick={() => void workflows.refetch()}
            icon={<RefreshCw className={workflows.isFetching ? "size-4 animate-spin" : "size-4"} />}
          />
        }
      />

      {workflows.isError ? (
        <ErrorState
          message={
            workflows.error instanceof ApiClientError
              ? workflows.error.message
              : "The workflow catalog could not be loaded."
          }
          onRetry={() => void workflows.refetch()}
        />
      ) : null}

      {workflows.isPending ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        {(workflows.data ?? []).map((workflow) => (
          <Card key={workflow.id}>
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
              <div className="flex gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent/10 text-accent">
                  <WorkflowIcon className="size-5" />
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-base">{workflow.name}</CardTitle>
                    <Badge tone="accent">v{workflow.version}</Badge>
                    <Badge tone="neutral">{workflow.slug}</Badge>
                  </div>
                  <CardDescription className="max-w-2xl">{workflow.description}</CardDescription>
                  <div className="mt-1 flex flex-wrap gap-3 font-mono text-[10px] text-faint">
                    <span>id: {workflow.id}</span>
                    <span>steps: {workflow.steps.length}</span>
                    <span>registered: {new Date(workflow.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>
              <Button
                variant="primary"
                icon={<Play className="size-3.5" />}
                onClick={() => {
                  setSelectedWorkflow(workflow.slug);
                  setLaunchOpen(true);
                }}
              >
                Run workflow
              </Button>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-[760px] text-left">
                  <thead>
                    <tr className="border-b border-line bg-raised/40 text-[10px] uppercase tracking-[0.14em] text-faint">
                      <th className="px-4 py-2.5 font-medium">#</th>
                      <th className="px-4 py-2.5 font-medium">Step</th>
                      <th className="px-4 py-2.5 font-medium">Description</th>
                      <th className="px-4 py-2.5 font-medium">Timeout</th>
                      <th className="px-4 py-2.5 font-medium">Retry policy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workflow.steps.map((step) => (
                      <tr key={step.key} className="border-b border-line/70 last:border-0">
                        <td className="px-4 py-3 font-mono text-[11px] text-faint">
                          {String(step.ordinal).padStart(2, "0")}
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-xs font-medium text-ink">{step.name}</div>
                          <div className="font-mono text-[10px] text-faint">{step.key}</div>
                        </td>
                        <td className="max-w-md px-4 py-3 text-xs text-muted">
                          {step.description}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-muted">
                          {formatDuration(step.timeoutMs)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-mono text-[11px] text-muted">
                            {step.retry.maxAttempts} attempt
                            {step.retry.maxAttempts === 1 ? "" : "s"} · {step.retry.backoff}
                          </div>
                          <div className="font-mono text-[10px] text-faint">
                            base {formatDuration(step.retry.baseDelayMs)} · max{" "}
                            {formatDuration(step.retry.maxDelayMs)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <InfoTile
                  icon={<Boxes className="size-4" />}
                  title="Deterministic"
                  description="Pure transformations only. No network calls, no LLM invocation, no user code."
                />
                <InfoTile
                  icon={<Code2 className="size-4" />}
                  title="Bounded input"
                  description="Title ≤ 120 characters, document ≤ 10,000 characters, strict JSON schema."
                />
                <InfoTile
                  icon={<WorkflowIcon className="size-4" />}
                  title="Durable execution"
                  description="Cloudflare Workflows checkpoints each step; D1 remains the system of record."
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <LaunchDialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        workflows={workflows.data ?? []}
        defaultWorkflowId={selectedWorkflow}
      />
    </>
  );
}

function InfoTile({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-2.5 rounded-lg border border-line bg-canvas/40 p-3">
      <span className="mt-0.5 text-faint">{icon}</span>
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-ink">{title}</span>
        <span className="text-[11px] leading-relaxed text-muted">{description}</span>
      </div>
    </div>
  );
}
