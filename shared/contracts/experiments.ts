import { z } from "zod";
import { FAILURE_SCENARIOS } from "../workflow/document";
export const experimentSchema = z
  .object({
    workflowId: z.string().min(1).max(80),
    version: z.number().int().positive(),
    input: z.unknown(),
    scenario: z.enum(FAILURE_SCENARIOS).default("success"),
    repetitions: z.number().int().min(1).max(5).default(1),
    expectedStatus: z.enum(["SUCCEEDED", "FAILED", "CANCELLED"]),
    outputPath: z.string().max(200).default(""),
    expectedValue: z.unknown().optional(),
    maxDurationMs: z.number().int().min(1).max(3600000).optional(),
  })
  .strict();
type Config = z.infer<typeof experimentSchema>;
export type ExperimentResult = {
  id: string;
  ordinal: number;
  status: string;
  output_json: string | null;
  duration_ms: number | null;
  workflow_version: number;
};
export function experimentVerdict(config: Config, run: ExperimentResult) {
  if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(run.status))
    return { status: "PENDING", checks: [] };
  const checks = [{ name: "Execution status", passed: run.status === config.expectedStatus }];
  if (Object.hasOwn(config, "expectedValue")) {
    let value: unknown = run.output_json ? JSON.parse(run.output_json) : null;
    for (const part of config.outputPath.split(".").filter(Boolean))
      value =
        value && typeof value === "object" && Object.hasOwn(value, part)
          ? (value as Record<string, unknown>)[part]
          : undefined;
    checks.push({
      name: "Output equals expected value",
      passed: JSON.stringify(value) === JSON.stringify(config.expectedValue),
    });
  }
  if (config.maxDurationMs !== undefined)
    checks.push({
      name: "Duration within limit",
      passed: run.duration_ms !== null && run.duration_ms <= config.maxDurationMs,
    });
  return { status: checks.every((c) => c.passed) ? "PASSED" : "FAILED", checks };
}
