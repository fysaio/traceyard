import { z } from "zod";
export const providerSchema = z.enum(["openai", "groq", "workers"]);
export const modelRouteSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    models: z
      .array(
        z
          .object({
            provider: providerSchema,
            model: z
              .string()
              .min(1)
              .max(150)
              .regex(/^[@A-Za-z0-9_./:-]+$/u)
              .refine(
                (value) =>
                  value
                    .split("/")
                    .every((part) => part.length > 0 && part !== "." && part !== ".."),
                "Use a model identifier without relative path segments.",
              ),
            inputPricePerMillion: z.number().min(0).max(10000).optional(),
            outputPricePerMillion: z.number().min(0).max(10000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(3),
    timeoutMs: z.number().int().min(1000).max(30000).default(15000),
    maxTokens: z.number().int().min(1).max(4096).default(1000),
  })
  .strict();
export type ModelRouteConfig = z.infer<typeof modelRouteSchema>;
export interface ModelResult {
  requestId: string;
  text: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  estimatedCostUsd: number | null;
  attempts: { provider: string; model: string; status: string; durationMs: number }[];
}
