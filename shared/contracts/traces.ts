import { z } from "zod";
const traceId = z
  .string()
  .regex(/^[a-f0-9]{32}$/u)
  .refine((v) => !/^0+$/u.test(v));
const spanId = z
  .string()
  .regex(/^[a-f0-9]{16}$/u)
  .refine((v) => !/^0+$/u.test(v));
export const spanSchema = z
  .object({
    traceId,
    spanId,
    parentSpanId: spanId.nullable().default(null),
    name: z.string().min(1).max(150),
    kind: z.enum(["workflow", "step", "model", "tool", "http", "custom"]).default("custom"),
    status: z.enum(["RUNNING", "SUCCEEDED", "FAILED"]),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable().default(null),
    attributes: z.record(z.string(), z.unknown()).default({}),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.string().max(2000).nullable().default(null),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.parentSpanId === s.spanId)
      ctx.addIssue({ code: "custom", message: "A span cannot parent itself." });
    if (s.endedAt && s.endedAt < s.startedAt)
      ctx.addIssue({ code: "custom", message: "End time must follow start time." });
    if ((s.status === "RUNNING" && s.endedAt) || (s.status !== "RUNNING" && !s.endedAt))
      ctx.addIssue({
        code: "custom",
        message: "Completed spans need an end time; running spans must not have one.",
      });
  });
export const spanBatchSchema = z
  .object({ spans: z.array(spanSchema).min(1).max(50) })
  .strict()
  .superRefine((batch, ctx) => {
    const ids = new Set<string>();
    for (const span of batch.spans) {
      const id = span.traceId + span.spanId;
      if (ids.has(id))
        ctx.addIssue({ code: "custom", message: "A batch cannot contain duplicate span IDs." });
      ids.add(id);
    }
  });
export type TraceSpan = z.infer<typeof spanSchema>;
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth limit]";
  if (typeof value === "string")
    return value
      .slice(0, 8000)
      .replace(/Bearer\s+[A-Za-z0-9._-]+/giu, "Bearer [redacted]")
      .replace(/(?:sk-|tyk_)[A-Za-z0-9_-]{16,}/gu, "[redacted]");
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([k, v]) => [
          k,
          /password|secret|token|authorization|cookie|api.?key/iu.test(k)
            ? "[redacted]"
            : redact(v, depth + 1),
        ]),
    );
  return value;
}
