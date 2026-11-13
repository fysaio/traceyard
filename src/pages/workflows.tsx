import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ErrorState } from "../components/empty-state";
import { LaunchDialog } from "../components/launch-dialog";
import { PageHeader } from "../components/page-header";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { Icon } from "../components/ui/icon";
import { Field, Input, Select, Textarea } from "../components/ui/input";
import { api, ApiClientError } from "../lib/api";
import { formatDuration } from "../lib/utils";

export function WorkflowsPage() {
  const [launchOpen, setLaunchOpen] = useState(false);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | undefined>(undefined);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [workflowName, setWorkflowName] = useState("");
  const [workflowDescription, setWorkflowDescription] = useState("");
  const [definitionJson, setDefinitionJson] = useState('{\n  "nodes": [],\n  "edges": []\n}');
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: api.workflows });
  const session = useQuery({ queryKey: ["auth-session"], queryFn: api.authSession });
  const authenticated = session.data?.user != null;
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
    enabled: authenticated,
  });
  const projectId =
    projects.data?.find((project) => project.id === selectedProjectId)?.id ??
    projects.data?.[0]?.id ??
    "";
  const savedWorkflows = useQuery({
    queryKey: ["saved-workflows", projectId],
    queryFn: () => api.savedWorkflows(projectId),
    enabled: authenticated && projectId.length > 0,
  });
  const createProject = useMutation({
    mutationFn: api.createProject,
    onSuccess: async (project) => {
      setSelectedProjectId(project.id);
      setProjectName("");
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const saveWorkflow = useMutation({
    mutationFn: (input: {
      name: string;
      description: string;
      definition: Record<string, unknown>;
    }) => api.createSavedWorkflow(projectId, input),
    onSuccess: async () => {
      setWorkflowName("");
      setWorkflowDescription("");
      setDefinitionError(null);
      await queryClient.invalidateQueries({ queryKey: ["saved-workflows", projectId] });
    },
  });
  const deleteWorkflow = useMutation({
    mutationFn: (workflowId: string) => api.deleteSavedWorkflow(projectId, workflowId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["saved-workflows", projectId] });
    },
  });

  return (
    <>
      <PageHeader
        eyebrow="Catalog"
        title="Workflows"
        description="Run built-in examples or save project-scoped workflow definitions. Saved definitions are durable data, not executable workflows."
        actions={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh workflows"
            onClick={() => void workflows.refetch()}
            icon={<Icon name="refresh" className={workflows.isFetching ? "animate-spin" : ""} />}
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
                  <Icon name="workflow" className="text-base" />
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
                icon={<Icon name="play" />}
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
                  icon={<Icon name="boxes" />}
                  title="Deterministic"
                  description="Pure transformations only. No network calls, no LLM invocation, no user code."
                />
                <InfoTile
                  icon={<Icon name="code" />}
                  title="Bounded input"
                  description="Title ≤ 120 characters, document ≤ 10,000 characters, strict JSON schema."
                />
                <InfoTile
                  icon={<Icon name="workflow" />}
                  title="Durable execution"
                  description="Cloudflare Workflows checkpoints each step; D1 remains the system of record."
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <section className="mt-8" aria-labelledby="saved-workflows-heading">
        <div className="mb-4">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
            Personal workspace
          </p>
          <h2
            id="saved-workflows-heading"
            className="mt-1 text-xl font-semibold tracking-tight text-ink"
          >
            Projects & saved definitions
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            Saved definitions persist in your account across devices. They are not yet editable
            graph workflows and cannot be executed.
          </p>
        </div>

        {session.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : session.isError ? (
          <ErrorState
            message="Account status could not be loaded."
            onRetry={() => void session.refetch()}
          />
        ) : !authenticated ? (
          <Card>
            <CardContent className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted">
                Sign in to create projects and save workflow definitions. The public sandbox remains
                available without an account.
              </p>
              {session.data.githubSignInAvailable ? (
                <a
                  href="/api/auth/github/start"
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-line-strong px-4 text-xs font-medium text-ink no-underline hover:bg-raised"
                >
                  <Icon name="github" /> Continue with GitHub
                </a>
              ) : (
                <p className="text-xs text-muted">
                  GitHub sign-in is unavailable in this deployment.
                </p>
              )}
            </CardContent>
          </Card>
        ) : projects.isPending ? (
          <Skeleton className="h-48 w-full" />
        ) : projects.isError ? (
          <ErrorState
            message={
              projects.error instanceof ApiClientError
                ? projects.error.message
                : "Projects could not be loaded."
            }
            onRetry={() => void projects.refetch()}
          />
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <Card>
              <CardHeader>
                <CardTitle>Projects</CardTitle>
                <CardDescription>
                  Your personal workspace is created when you sign in.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <Field label="Selected project" htmlFor="saved-workflow-project">
                  <Select
                    id="saved-workflow-project"
                    value={projectId}
                    onChange={(event) => setSelectedProjectId(event.target.value)}
                    disabled={projects.data.length === 0}
                  >
                    {projects.data.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {projects.data.length === 0 ? (
                  <p className="text-xs text-muted">
                    No projects are available. Create one to begin saving definitions.
                  </p>
                ) : (
                  <p className="font-mono text-[10px] text-faint">
                    {projects.data.find((project) => project.id === projectId)?.slug}
                  </p>
                )}
                <form
                  className="flex flex-col gap-3 border-t border-line pt-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = projectName.trim();
                    if (name.length > 0) createProject.mutate(name);
                  }}
                >
                  <Field label="New project" htmlFor="new-project-name">
                    <Input
                      id="new-project-name"
                      value={projectName}
                      onChange={(event) => setProjectName(event.target.value)}
                      maxLength={80}
                      placeholder="Project name"
                    />
                  </Field>
                  {createProject.isError ? (
                    <p role="alert" className="text-xs text-ink">
                      {createProject.error instanceof ApiClientError
                        ? createProject.error.message
                        : "The project could not be created."}
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    variant="secondary"
                    size="sm"
                    loading={createProject.isPending}
                    disabled={projectName.trim().length === 0}
                  >
                    Create project
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Saved workflow definitions</CardTitle>
                <CardDescription>
                  Stored as project data only; saving one does not make it executable.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {projectId.length === 0 ? (
                  <p className="text-xs text-muted">Create a project to save a definition.</p>
                ) : savedWorkflows.isPending ? (
                  <Skeleton className="h-24 w-full" />
                ) : savedWorkflows.isError ? (
                  <ErrorState
                    message={
                      savedWorkflows.error instanceof ApiClientError
                        ? savedWorkflows.error.message
                        : "Saved definitions could not be loaded."
                    }
                    onRetry={() => void savedWorkflows.refetch()}
                  />
                ) : savedWorkflows.data.length === 0 ? (
                  <p className="text-xs text-muted">No saved definitions in this project yet.</p>
                ) : (
                  <ul className="divide-y divide-line border-y border-line">
                    {savedWorkflows.data.map((workflow) => (
                      <li key={workflow.id} className="flex flex-col gap-2 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-ink">{workflow.name}</p>
                            <p className="mt-1 text-xs leading-relaxed text-muted">
                              {workflow.description || "No description"}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Delete saved definition ${workflow.name}`}
                            disabled={deleteWorkflow.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Delete the saved definition "${workflow.name}" from this project?`,
                                )
                              ) {
                                deleteWorkflow.mutate(workflow.id);
                              }
                            }}
                            icon={<Icon name="x" />}
                          >
                            Delete
                          </Button>
                        </div>
                        <details className="text-xs text-muted">
                          <summary className="cursor-pointer underline underline-offset-4">
                            Inspect saved definition
                          </summary>
                          <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed">
                            {JSON.stringify(workflow.definition, null, 2)}
                          </pre>
                        </details>
                      </li>
                    ))}
                  </ul>
                )}

                {deleteWorkflow.isError ? (
                  <p role="alert" className="text-xs text-ink">
                    {deleteWorkflow.error instanceof ApiClientError
                      ? deleteWorkflow.error.message
                      : "The saved definition could not be deleted."}
                  </p>
                ) : null}
                <form
                  className="flex flex-col gap-3 border-t border-line pt-4"
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    setDefinitionError(null);
                    let definition: unknown;
                    try {
                      definition = JSON.parse(definitionJson) as unknown;
                    } catch {
                      setDefinitionError("Enter a valid JSON object.");
                      return;
                    }
                    if (!isRecord(definition)) {
                      setDefinitionError("The workflow definition must be a JSON object.");
                      return;
                    }
                    if (workflowName.trim().length === 0) {
                      setDefinitionError("A workflow name is required.");
                      return;
                    }
                    saveWorkflow.mutate({
                      name: workflowName.trim(),
                      description: workflowDescription.trim(),
                      definition,
                    });
                  }}
                >
                  <Field label="Definition name" htmlFor="saved-workflow-name">
                    <Input
                      id="saved-workflow-name"
                      value={workflowName}
                      onChange={(event) => setWorkflowName(event.target.value)}
                      maxLength={120}
                      required
                      placeholder="Invoice recovery"
                    />
                  </Field>
                  <Field label="Description" htmlFor="saved-workflow-description">
                    <Input
                      id="saved-workflow-description"
                      value={workflowDescription}
                      onChange={(event) => setWorkflowDescription(event.target.value)}
                      maxLength={500}
                      placeholder="What this definition is for"
                    />
                  </Field>
                  <Field label="Definition JSON" htmlFor="saved-workflow-definition">
                    <Textarea
                      id="saved-workflow-definition"
                      value={definitionJson}
                      onChange={(event) => setDefinitionJson(event.target.value)}
                      rows={5}
                      className="font-mono text-xs"
                      spellCheck={false}
                      required
                    />
                  </Field>
                  {definitionError !== null ? (
                    <p role="alert" className="text-xs text-ink">
                      {definitionError}
                    </p>
                  ) : null}
                  {saveWorkflow.isError ? (
                    <p role="alert" className="text-xs text-ink">
                      {saveWorkflow.error instanceof ApiClientError
                        ? saveWorkflow.error.message
                        : "The workflow definition could not be saved."}
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    variant="secondary"
                    size="sm"
                    loading={saveWorkflow.isPending}
                    disabled={projectId.length === 0}
                  >
                    Save definition
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        )}
      </section>

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
