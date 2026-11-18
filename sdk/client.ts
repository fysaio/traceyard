/** Server-side TypeScript client. Import this file directly until a package is published. */
export interface SpanContext {
  traceId: string;
  spanId: string;
}
export interface SpanOptions {
  parent?: SpanContext;
  kind?: "workflow" | "step" | "model" | "tool" | "http" | "custom";
  attributes?: Record<string, unknown>;
}
export class TraceyardClient {
  private origin: string;
  constructor(
    private options: {
      origin: string;
      apiKey: string;
      fetch?: typeof fetch;
      onTelemetryError?: (error: Error) => void;
    },
  ) {
    const url = new URL(options.origin);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
    )
      throw new Error("Use an HTTPS origin.");
    this.origin = url.origin;
  }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const r = await (this.options.fetch ?? fetch)(this.origin + "/api/v1" + path, {
      method,
      headers: {
        Authorization: "Bearer " + this.options.apiKey,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    const result = (await r.json()) as { data: unknown; error?: { message: string } };
    if (!r.ok) throw new Error(result.error?.message ?? "Traceyard request failed.");
    return result.data;
  }
  launch(
    input: { workflowId: string; version?: number; input: unknown; parentRunId?: string },
    idempotencyKey = crypto.randomUUID(),
  ) {
    return this.request(
      "/runs",
      "POST",
      { ...input, scenario: "success" },
      { "Idempotency-Key": idempotencyKey },
    );
  }
  run(id: string) {
    return this.request("/runs/" + encodeURIComponent(id));
  }
  retry(id: string, mode: "resume" | "restart" = "resume") {
    return this.request("/runs/" + encodeURIComponent(id) + "/retry", "POST", { mode });
  }
  events(id: string, after = 0) {
    return this.request(
      "/runs/" + encodeURIComponent(id) + "/events?after=" + after + "&limit=200",
    );
  }
  cancel(id: string) {
    return this.request("/runs/" + encodeURIComponent(id) + "/cancel", "POST");
  }
  traceparent(context: SpanContext) {
    return `00-${context.traceId}-${context.spanId}-01`;
  }
  parseTraceparent(header: string): SpanContext | undefined {
    const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/u.exec(header);
    return match && !/^0+$/u.test(match[1]!) && !/^0+$/u.test(match[2]!)
      ? { traceId: match[1]!, spanId: match[2]! }
      : undefined;
  }
  async span<T>(
    name: string,
    work: (context: SpanContext) => Promise<T>,
    options: SpanOptions = {},
  ): Promise<T> {
    const context = {
        traceId: options.parent?.traceId ?? crypto.randomUUID().replaceAll("-", ""),
        spanId: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
      },
      startedAt = new Date().toISOString();
    const base = {
      ...context,
      parentSpanId: options.parent?.spanId ?? null,
      name,
      kind: options.kind ?? "custom",
      startedAt,
      attributes: options.attributes ?? {},
    };
    const send = async (record: unknown) => {
      try {
        await this.request("/traces", "POST", { spans: [record] });
      } catch (error) {
        const safe = new Error(
          error instanceof Error ? error.message : "Telemetry delivery failed.",
        );
        try {
          if (this.options.onTelemetryError) this.options.onTelemetryError(safe);
          else console.warn("Traceyard telemetry delivery failed.");
        } catch {
          /* Telemetry callbacks must not change the application outcome. */
        }
      }
    };
    await send({ ...base, status: "RUNNING", endedAt: null });
    try {
      const result = await work(context);
      await send({ ...base, status: "SUCCEEDED", endedAt: new Date().toISOString() });
      return result;
    } catch (error) {
      await send({
        ...base,
        status: "FAILED",
        endedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Operation failed.",
      });
      throw error;
    }
  }
}
