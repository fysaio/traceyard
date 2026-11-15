import type { WorkflowGraph } from "../../shared/workflow/graph";
import { ApiClientError } from "./api";
export interface StudioWorkflow {
  id: string;
  name: string;
  description: string;
  current_version: number;
  revision: number;
  graph: WorkflowGraph;
  versions: { version: number; checksum: string; created_at: string }[];
}
async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = (await r.json()) as { data: T; error?: { code: string; message: string } };
  if (!r.ok)
    throw new ApiClientError(
      r.status,
      result.error?.code ?? "REQUEST_FAILED",
      result.error?.message ?? "The request failed.",
    );
  return result.data;
}
const path = (projectId: string, id?: string) =>
  `/projects/${encodeURIComponent(projectId)}/studio${id ? "/" + encodeURIComponent(id) : ""}`;
export const studioApi = {
  list: (p: string) => call<{ items: Omit<StudioWorkflow, "graph" | "versions">[] }>(path(p)),
  create: (p: string, name: string) =>
    call<{ id: string; revision: number }>(path(p), "POST", { name }),
  get: (p: string, id: string) => call<StudioWorkflow>(path(p, id)),
  save: (p: string, w: StudioWorkflow) =>
    call<{ revision: number }>(path(p, w.id), "PUT", {
      name: w.name,
      description: w.description,
      revision: w.revision,
      graph: w.graph,
    }),
  publish: (p: string, id: string, revision: number) =>
    call<{ version: number }>(path(p, id) + "/publish", "POST", { revision }),
  archive: (p: string, id: string) => call(path(p, id), "DELETE"),
};
