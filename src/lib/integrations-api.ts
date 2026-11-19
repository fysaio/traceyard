import { ApiClientError } from "./api";
export async function integrationRequest<T>(
  project: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/projects/${encodeURIComponent(project)}/${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = (await response.json()) as {
    data: T;
    error?: { message: string; code?: string; details?: unknown };
  };
  if (!response.ok)
    throw new ApiClientError(
      response.status,
      result.error?.code ?? "REQUEST_FAILED",
      result.error?.message ?? "Request failed.",
      result.error?.details,
    );
  return result.data;
}
