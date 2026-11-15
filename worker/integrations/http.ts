import { outboundUrl } from "./outbound";
import { decryptSecret } from "./secrets";
import { randomId } from "../lib/crypto";
import { nowIso } from "../lib/time";
import { notFound } from "../api/errors";
export interface HttpConnection {
  id: string;
  name: string;
  url: string;
  method: string;
}
export async function readHttpConnection(
  env: Env,
  projectId: string,
  id: string,
): Promise<HttpConnection> {
  const row = await env.DB.prepare(
    "SELECT id,name,url,method FROM http_connections WHERE id=? AND project_id=?",
  )
    .bind(id, projectId)
    .first<HttpConnection>();
  if (!row) throw notFound("HTTP connection not found in this project.");
  outboundUrl(env, row.url);
  return row;
}
export async function callHttp(
  env: Env,
  projectId: string,
  runId: string,
  nodeId: string,
  connection: HttpConnection,
  input: unknown,
  fetcher: typeof fetch = fetch,
) {
  const credential = await env.DB.prepare(
    "SELECT secret_ciphertext FROM http_connections WHERE id=? AND project_id=?",
  )
    .bind(connection.id, projectId)
    .first<{ secret_ciphertext: string | null }>();
  if (!credential)
    throw new Error("The HTTP connection was removed. Configure it again before retrying.");
  const id = randomId("http"),
    start = Date.now();
  await env.DB.prepare(
    "INSERT INTO http_requests (id,project_id,run_id,node_id,connection_id,status,duration_ms,created_at) VALUES (?,?,?,?,?,?,0,?)",
  )
    .bind(id, projectId, runId, nodeId, connection.id, "RUNNING", nowIso())
    .run();
  let status: number | null = null;
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Idempotency-Key": runId + ":" + nodeId,
    };
    if (credential.secret_ciphertext)
      headers.Authorization =
        "Bearer " +
        (await decryptSecret(
          env,
          credential.secret_ciphertext,
          projectId + ":http:" + connection.id,
        ));
    const body = connection.method === "GET" ? undefined : JSON.stringify(input);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetcher(outboundUrl(env, connection.url), {
      method: connection.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("HTTP connection returned status " + status + ".");
    }
    const reader = response.body?.getReader();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder();
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 24000) {
          await reader.cancel();
          throw new Error("HTTP response exceeds 24 KB.");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    }
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("The HTTP connection must return JSON.");
      }
    }
    await env.DB.prepare(
      "UPDATE http_requests SET status='SUCCEEDED',http_status=?,duration_ms=? WHERE id=?",
    )
      .bind(status, Date.now() - start, id)
      .run();
    return { status, data, requestId: id };
  } catch (error) {
    const message =
      error instanceof Error && /^HTTP /u.test(error.message)
        ? error.message
        : "HTTP request failed or timed out.";
    await env.DB.prepare(
      "UPDATE http_requests SET status='FAILED',http_status=?,duration_ms=?,error=? WHERE id=?",
    )
      .bind(status, Date.now() - start, message, id)
      .run();
    throw new Error(message, { cause: error });
  }
}
