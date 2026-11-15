import {
  modelRouteSchema,
  type ModelRouteConfig,
  type ModelResult,
} from "../../shared/contracts/gateway";
import { randomId } from "../lib/crypto";
import { nowIso, isoFromNow } from "../lib/time";
import { decryptSecret } from "./secrets";
import { badRequest, notFound, serviceUnavailable, tooManyRequests } from "../api/errors";
export async function readModelRoute(env: Env, projectId: string, id: string) {
  const row = await env.DB.prepare(
    "SELECT config_json FROM model_routes WHERE id=? AND project_id=?",
  )
    .bind(id, projectId)
    .first<{ config_json: string }>();
  if (!row) throw notFound("Model route not found.");
  return modelRouteSchema.parse(JSON.parse(row.config_json));
}
async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty provider response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    size += r.value.length;
    if (size > 128000) {
      await reader.cancel();
      throw new Error("Provider response exceeds the size limit.");
    }
    chunks.push(r.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}
export async function callModel(
  env: Env,
  projectId: string,
  routeId: string,
  prompt: string,
  context: { runId?: string; stepKey?: string; route?: ModelRouteConfig } = {},
  fetcher: typeof fetch = fetch,
): Promise<ModelResult> {
  const config = context.route ?? (await readModelRoute(env, projectId, routeId)),
    id = randomId("model"),
    start = Date.now(),
    now = nowIso(),
    hour = now.slice(0, 13);
  const admitted = await env.DB.prepare(
    "INSERT INTO quota_counters (bucket_key,count,limit_value,window_start,expires_at,updated_at) VALUES (?,1,60,?,?,?) ON CONFLICT(bucket_key) DO UPDATE SET count=count+1 WHERE count<60 RETURNING count",
  )
    .bind("models:" + projectId + ":" + hour, hour + ":00:00.000Z", isoFromNow(2 * 3600000), now)
    .first();
  if (!admitted)
    throw tooManyRequests(
      "MODEL_QUOTA",
      "This project has reached 60 model requests per hour.",
      3600,
    );
  await env.DB.prepare(
    "INSERT INTO model_requests (id,project_id,route_id,route_snapshot_json,run_id,step_key,status,duration_ms,attempts_json,created_at) VALUES (?,?,?,?,?,?,?,0,?,?)",
  )
    .bind(
      id,
      projectId,
      routeId,
      JSON.stringify(config),
      context.runId ?? null,
      context.stepKey ?? null,
      "RUNNING",
      "[]",
      now,
    )
    .run();
  const attempts: ModelResult["attempts"] = [];
  let failure = "No model was available.";
  for (const target of config.models) {
    const attemptStart = Date.now();
    let transient = false;
    try {
      const row = await env.DB.prepare(
        "SELECT secret_ciphertext FROM provider_credentials WHERE project_id=? AND provider=?",
      )
        .bind(projectId, target.provider)
        .first<{ secret_ciphertext: string }>();
      if (!row)
        throw badRequest(
          "PROVIDER_UNCONFIGURED",
          `Configure ${target.provider} credentials before calling this route.`,
        );
      const credentials = JSON.parse(
        await decryptSecret(env, row.secret_ciphertext, projectId + ":" + target.provider),
      ) as { apiKey: string; accountId?: string };
      const url =
        target.provider === "workers"
          ? `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/ai/run/${target.model.split("/").map(encodeURIComponent).join("/")}`
          : target.provider === "groq"
            ? "https://api.groq.com/openai/v1/chat/completions"
            : "https://api.openai.com/v1/chat/completions";
      const body =
        target.provider === "workers"
          ? { messages: [{ role: "user", content: prompt }], max_tokens: config.maxTokens }
          : {
              model: target.model,
              messages: [{ role: "user", content: prompt }],
              max_completion_tokens: config.maxTokens,
              stream: false,
            };
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        transient = response.status === 429 || response.status >= 500;
        throw new Error("Provider request failed (HTTP " + response.status + ").");
      }
      const data = await boundedJson(response);
      let text: unknown, usage: Record<string, unknown> | undefined;
      if (target.provider === "workers") {
        const result = data.result as Record<string, unknown> | undefined;
        if (data.success === false) throw new Error("Workers AI rejected the request.");
        text = result?.response;
        usage = result?.usage as Record<string, unknown> | undefined;
      } else {
        text = (data.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message
          ?.content;
        usage = data.usage as Record<string, unknown> | undefined;
      }
      if (typeof text !== "string")
        throw new Error("The provider returned an invalid text response.");
      const tokens = (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
      const inputTokens = tokens(usage?.prompt_tokens ?? usage?.input_tokens),
        outputTokens = tokens(usage?.completion_tokens ?? usage?.output_tokens);
      const estimatedCostUsd =
        inputTokens !== null &&
        outputTokens !== null &&
        target.inputPricePerMillion !== undefined &&
        target.outputPricePerMillion !== undefined
          ? (inputTokens * target.inputPricePerMillion +
              outputTokens * target.outputPricePerMillion) /
            1e6
          : null;
      attempts.push({
        provider: target.provider,
        model: target.model,
        status: "SUCCEEDED",
        durationMs: Date.now() - attemptStart,
      });
      const result = {
        requestId: id,
        text,
        provider: target.provider,
        model: target.model,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - start,
        estimatedCostUsd,
        attempts,
      };
      await env.DB.prepare(
        "UPDATE model_requests SET status=?,provider=?,model=?,input_tokens=?,output_tokens=?,duration_ms=?,attempts_json=?,estimated_cost_usd=? WHERE id=?",
      )
        .bind(
          "SUCCEEDED",
          target.provider,
          target.model,
          inputTokens,
          outputTokens,
          result.durationMs,
          JSON.stringify(attempts),
          estimatedCostUsd,
          id,
        )
        .run();
      return result;
    } catch (error) {
      failure =
        error instanceof Error && "code" in error
          ? error.message
          : error instanceof Error &&
              /^Provider request failed|The provider returned|Workers AI/u.test(error.message)
            ? error.message
            : "Provider connection failed or timed out.";
      if (
        error instanceof Error &&
        ["TimeoutError", "AbortError", "TypeError"].includes(error.name)
      )
        transient = true;
      attempts.push({
        provider: target.provider,
        model: target.model,
        status: failure,
        durationMs: Date.now() - attemptStart,
      });
      if (!transient) break;
    }
  }
  await env.DB.prepare(
    "UPDATE model_requests SET status=?,duration_ms=?,attempts_json=? WHERE id=?",
  )
    .bind("FAILED", Date.now() - start, JSON.stringify(attempts), id)
    .run();
  throw serviceUnavailable("MODEL_REQUEST_FAILED", failure);
}
