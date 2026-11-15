import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { EmptyState, ErrorState } from "../components/empty-state";
import { LaunchDialog } from "../components/launch-dialog";
import { PageHeader } from "../components/page-header";
import { RunTable } from "../components/run-table";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Select } from "../components/ui/input";
import { SkeletonRows } from "../components/ui/skeleton";
import { Icon } from "../components/ui/icon";
import type { RunStatus } from "../../shared/domain/status";
import { RUN_STATUSES } from "../../shared/domain/status";
import { api, ApiClientError } from "../lib/api";

const PAGE_SIZE = 25;

export function ExecutionsPage() {
  const [launchOpen, setLaunchOpen] = useState(false);
  const [status, setStatus] = useState<RunStatus | "">("");
  const [workflowId, setWorkflowId] = useState("");

  const workflows = useQuery({ queryKey: ["workflows"], queryFn: () => api.workflows() });

  const runs = useInfiniteQuery({
    queryKey: ["runs", status, workflowId],
    queryFn: ({ pageParam }) =>
      api.runs({
        status: status === "" ? undefined : status,
        workflowId: workflowId === "" ? undefined : workflowId,
        cursor: pageParam ?? undefined,
        limit: PAGE_SIZE,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages;
      const hasActive = pages?.some((page) =>
        page.items.some(
          (run) =>
            run.status === "QUEUED" || run.status === "RUNNING" || run.status === "CANCELLING",
        ),
      );
      return hasActive === true ? 4_000 : false;
    },
  });

  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const activeCount = items.filter(
    (run) => run.status === "QUEUED" || run.status === "RUNNING" || run.status === "CANCELLING",
  ).length;

  return (
    <>
      <PageHeader
        eyebrow="Executions"
        title="Execution ledger"
        description="Every run is persisted in D1 with its steps, attempts, events and dispatch record. The ledger is the system of record; queue delivery is at-least-once."
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh executions"
              onClick={() => void runs.refetch()}
              icon={<Icon name="refresh" className={runs.isFetching ? "animate-spin" : ""} />}
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

      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-faint">
              <Icon name="filter" />
              Filters
            </div>
            <Select
              value={status}
              onChange={(event) => setStatus(event.target.value as RunStatus | "")}
              className="h-8 w-auto min-w-[130px] text-xs"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {RUN_STATUSES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </Select>
            <Select
              value={workflowId}
              onChange={(event) => setWorkflowId(event.target.value)}
              className="h-8 w-auto min-w-[160px] text-xs"
              aria-label="Filter by workflow"
            >
              <option value="">All workflows</option>
              {(workflows.data ?? []).map((workflow) => (
                <option key={workflow.id} value={workflow.slug}>
                  {workflow.name}
                </option>
              ))}
            </Select>
            <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-faint">
              {items.length} loaded
              {activeCount > 0 ? ` · ${activeCount} active` : ""}
            </span>
          </div>

          {runs.isError ? (
            <ErrorState
              message={
                runs.error instanceof ApiClientError
                  ? runs.error.message
                  : "Executions could not be loaded."
              }
              onRetry={() => void runs.refetch()}
            />
          ) : runs.isPending ? (
            <SkeletonRows rows={6} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Icon name="inbox" />}
              title={
                status === "" && workflowId === ""
                  ? "No executions yet"
                  : "No runs match these filters"
              }
              description={
                status === "" && workflowId === ""
                  ? "Launch an available workflow to create a real execution with durable steps, retries and a dispatch record."
                  : "Change or clear the filters to inspect other executions in this session."
              }
              action={
                status === "" && workflowId === "" ? (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Icon name="play" />}
                    onClick={() => setLaunchOpen(true)}
                    disabled={workflows.data === undefined || workflows.data.length === 0}
                  >
                    Launch first run
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setStatus("");
                      setWorkflowId("");
                    }}
                  >
                    Clear filters
                  </Button>
                )
              }
            />
          ) : (
            <div className="-mx-4 border-y border-line sm:-mx-4">
              <RunTable runs={items} />
            </div>
          )}

          {runs.hasNextPage ? (
            <div className="flex justify-center pt-1">
              <Button
                variant="secondary"
                size="sm"
                loading={runs.isFetchingNextPage}
                onClick={() => void runs.fetchNextPage()}
              >
                Load older executions
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <LaunchDialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        workflows={workflows.data ?? []}
      />
    </>
  );
}
