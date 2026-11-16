import { z } from "zod";
import { badRequest, parseWith } from "../api/errors";
const value = z.object({
  stringValue: z.string().optional(),
  intValue: z.union([z.string(), z.number()]).optional(),
  doubleValue: z.number().optional(),
  boolValue: z.boolean().optional(),
});
const attribute = z.object({ key: z.string(), value });
const span = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  kind: z.number().optional(),
  startTimeUnixNano: z.string().regex(/^\d{1,24}$/),
  endTimeUnixNano: z.string().regex(/^\d{1,24}$/),
  attributes: z.array(attribute).optional(),
  status: z.object({ code: z.number().optional() }).optional(),
});
const batch = z.object({
  resourceSpans: z.array(
    z.object({
      resource: z.object({ attributes: z.array(attribute).optional() }).optional(),
      scopeSpans: z.array(z.object({ spans: z.array(span) })),
    }),
  ),
});
const allowed = new Set([
  "service.name",
  "service.version",
  "http.route",
  "http.request.method",
  "http.response.status_code",
  "http.method",
  "http.status_code",
  "db.system",
  "db.system.name",
  "gen_ai.system",
  "gen_ai.request.model",
  "code.filepath",
  "code.function",
  "code.lineno",
  "code.file.path",
  "code.function.name",
  "code.line.number",
  "error.type",
  "traceyard.run.id",
  "traceyard.operation.key",
  "traceyard.test.case",
]);
export function convertOtlp(input: unknown) {
  const b = parseWith(batch, input, "Send OTLP HTTP JSON trace data.");
  const convert = (attrs: z.infer<typeof attribute>[] = []) =>
    Object.fromEntries(
      attrs
        .filter((a) => allowed.has(a.key))
        .map((a) => [
          a.key,
          a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue,
        ]),
    );
  const date = (nano: string) => {
    const value = Number(BigInt(nano) / 1000000n);
    if (!Number.isFinite(value) || value < 0 || value > 8640000000000000)
      throw badRequest("INVALID_TIMESTAMP", "Invalid span timestamp.");
    return new Date(value).toISOString();
  };
  return b.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) =>
      scope.spans.map((s) => {
        const attributes = { ...convert(resource.resource?.attributes), ...convert(s.attributes) };
        const parentSpanId = s.parentSpanId && !/^0+$/.test(s.parentSpanId) ? s.parentSpanId : null;
        return {
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId,
          name: s.name.slice(0, 150),
          kind: parentSpanId
            ? attributes["gen_ai.system"]
              ? "model"
              : s.kind === 3
                ? "http"
                : "step"
            : "workflow",
          status: s.status?.code === 2 ? "FAILED" : "SUCCEEDED",
          startedAt: date(s.startTimeUnixNano),
          endedAt: date(s.endTimeUnixNano),
          attributes: { ...attributes, service: attributes["service.name"] ?? "Application" },
          error:
            s.status?.code === 2 ? String(attributes["error.type"] ?? "Operation failed") : null,
        };
      }),
    ),
  );
}
