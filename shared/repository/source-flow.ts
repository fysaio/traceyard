import { z } from "zod";

export const sourceFlowSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            id: z
              .string()
              .max(3)
              .regex(/^c\d+$/),
            parentId: z
              .string()
              .max(3)
              .regex(/^c\d+$/)
              .nullable(),
            name: z.string().min(1).max(150),
            line: z.number().int().positive(),
            context: z.enum(["conditional", "error", "loop", "callback"]).optional(),
            resolution: z.enum(["local", "unresolved", "recursive"]),
          })
          .strict(),
      )
      .max(12),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((flow, ctx) => {
    const seen = new Set<string>();
    for (const step of flow.steps) {
      if (seen.has(step.id) || (step.parentId !== null && !seen.has(step.parentId)))
        ctx.addIssue({
          code: "custom",
          message: "Source calls need unique IDs and preceding parents.",
        });
      seen.add(step.id);
    }
  });
export type SourceFlow = z.infer<typeof sourceFlowSchema>;
