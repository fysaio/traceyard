import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import type { WorkflowSummary } from "../../shared/contracts/api";
import type { FailureScenario } from "../../shared/workflow/document";
import { api, ApiClientError, newIdempotencyKey } from "../lib/api";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import { Field, Input, Select, Textarea } from "./ui/input";
import { Icon } from "./ui/icon";

const EXAMPLE_DOCUMENT = `Incident review: queue saturation
Owner: Platform Reliability
Severity: SEV-2

At 09:12 UTC the execution queue exceeded its polling budget, which delayed workflow dispatch by roughly four minutes. The on-call engineer drained the backlog and replayed the affected executions. No data was lost.

The root cause was a burst of bursty retries that arrived in the same second. We will add jitter to the retry policy and alert when queue depth stays above 500 for more than two minutes.`;

export function LaunchDialog({
  open,
  onOpenChange,
  workflows,
  defaultWorkflowId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflows: WorkflowSummary[];
  defaultWorkflowId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Launch a sandbox execution"
        description="Runs are private to your anonymous browser session and are retained for a limited window. No external network calls or arbitrary code are executed."
      >
        <LaunchForm
          workflows={workflows}
          defaultWorkflowId={defaultWorkflowId}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function LaunchForm({
  workflows,
  defaultWorkflowId,
  onClose,
}: {
  workflows: WorkflowSummary[];
  defaultWorkflowId?: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fallbackSlug = workflows[0]?.slug ?? "";
  const initialSlug =
    defaultWorkflowId !== undefined &&
    workflows.some((workflow) => workflow.slug === defaultWorkflowId)
      ? defaultWorkflowId
      : fallbackSlug;

  const [workflowId, setWorkflowId] = useState(initialSlug);
  const [title, setTitle] = useState("Queue saturation incident review");
  const [document, setDocument] = useState(EXAMPLE_DOCUMENT);
  const [scenario, setScenario] = useState<FailureScenario>("success");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const selected = workflows.find((workflow) => workflow.slug === workflowId);

  async function submit() {
    setError(null);
    if (title.trim().length < 3) {
      setError("Title must be at least 3 characters.");
      return;
    }
    if (document.length < 24) {
      setError("Document must be at least 24 characters.");
      return;
    }
    setPending(true);
    try {
      const { result, replayed } = await api.launch(
        { workflowId, input: { title: title.trim(), document }, scenario },
        idempotencyKey,
      );
      onClose();
      setIdempotencyKey(newIdempotencyKey());
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["analytics"] });
      void queryClient.invalidateQueries({ queryKey: ["sandbox"] });
      navigate(`/executions/${result.run.id}${replayed ? "?replayed=1" : ""}`);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught.message
          : "The execution could not be launched. Check your connection and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field label="Workflow" htmlFor="launch-workflow">
        <Select
          id="launch-workflow"
          value={workflowId}
          onChange={(event) => setWorkflowId(event.target.value)}
          disabled={pending}
        >
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.slug}>
              {workflow.name} · v{workflow.version}
            </option>
          ))}
        </Select>
        {selected === undefined ? null : (
          <p className="text-[11px] leading-relaxed text-faint">{selected.description}</p>
        )}
      </Field>

      <Field label="Title" hint={`${title.length}/120`} htmlFor="launch-title">
        <Input
          id="launch-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={120}
          disabled={pending}
          placeholder="Short incident title"
        />
      </Field>

      <Field label="Document" hint={`${document.length}/10000`} htmlFor="launch-document">
        <Textarea
          id="launch-document"
          value={document}
          onChange={(event) => setDocument(event.target.value)}
          maxLength={10_000}
          rows={7}
          disabled={pending}
          className="font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => setDocument(EXAMPLE_DOCUMENT)}
          className="self-start text-[11px] text-faint underline decoration-line-strong underline-offset-4 hover:text-accent"
        >
          Reset to example document
        </button>
      </Field>

      <Field
        label="Fault scenario"
        hint="Deterministic, server-enforced failure injection"
        htmlFor="launch-scenario"
      >
        <Select
          id="launch-scenario"
          value={scenario}
          onChange={(event) => setScenario(event.target.value as FailureScenario)}
          disabled={pending}
        >
          <option value="success">success — complete normally</option>
          <option value="retryable_failure">
            retryable_failure — first extraction attempt fails transiently
          </option>
          <option value="terminal_failure">terminal_failure — extraction fails permanently</option>
        </Select>
      </Field>

      {error === null ? null : (
        <p className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="mt-1 flex items-center justify-between gap-3 border-t border-line pt-4">
        <p className="flex items-center gap-1.5 text-[11px] text-faint">
          <Icon name="flask" />
          Quotas and circuit breaker apply.
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending} icon={<Icon name="play" />}>
            Launch run
          </Button>
        </div>
      </div>
    </form>
  );
}
