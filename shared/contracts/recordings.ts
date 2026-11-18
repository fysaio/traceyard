import { z } from "zod";
import { repositoryPathSchema } from "./repository-index";
export const recordingManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("json-fetch"),
    sourceCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    testPath: repositoryPathSchema,
    interactions: z
      .array(
        z
          .object({
            signature: z.string().regex(/^[a-f0-9]{64}$/),
            method: z.string().regex(/^[A-Z]{1,10}$/),
            url: z.string().url().max(1000),
            requestBody: z.unknown(),
            response: z
              .object({ status: z.number().int().min(200).max(599), body: z.unknown() })
              .strict(),
          })
          .strict(),
      )
      .max(8),
    environment: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/),
            kind: z.enum(["credential", "url"]),
            protocol: z
              .string()
              .regex(/^[a-z]+:$/)
              .optional(),
          })
          .strict(),
      )
      .max(30),
    omissions: z.array(z.string().max(300)).max(20),
    eligible: z.boolean(),
  })
  .strict();
export type RecordingManifest = z.infer<typeof recordingManifestSchema>;
