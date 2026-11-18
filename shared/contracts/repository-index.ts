import { z } from "zod";
export const repositoryPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (p) =>
      !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes("..") && !p.startsWith("-"),
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const indexedFileSchema = z
  .object({
    path: repositoryPathSchema,
    hash: digest,
    imports: z
      .array(
        z
          .object({ specifier: z.string().max(240), resolved: repositoryPathSchema.nullable() })
          .strict(),
      )
      .max(40),
    tests: z
      .array(z.object({ name: z.string().max(200), line: z.number().int().positive() }).strict())
      .max(40),
    definitions: z.array(z.string().max(100)).max(40),
    isTest: z.boolean(),
    packageDirectory: repositoryPathSchema,
  })
  .strict();
export const repositoryPackageSchema = z
  .object({
    directory: repositoryPathSchema,
    name: z.string().max(150),
    scripts: z.array(z.string().regex(/^[A-Za-z0-9:_-]{1,80}$/)).max(50),
    testRunner: z.enum(["vitest", "jest", "node", "unknown"]),
    manager: z.enum(["npm", "pnpm", "yarn"]),
    hash: digest,
    lockHash: digest.nullable(),
  })
  .strict();
export const repositoryIndexManifestSchema = z
  .object({
    snapshotId: digest,
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    packages: z.array(repositoryPackageSchema).max(50),
    fileCount: z.number().int().min(0).max(5000),
    coverage: z
      .object({
        scanned: z.number().int().min(0).max(5000),
        skipped: z.number().int().min(0),
        truncated: z.boolean(),
        warnings: z.array(z.string().max(300)).max(20),
      })
      .strict(),
  })
  .strict();
export type IndexedFile = z.infer<typeof indexedFileSchema>;
export type RepositoryPackage = z.infer<typeof repositoryPackageSchema>;
export type RepositoryIndexManifest = z.infer<typeof repositoryIndexManifestSchema>;
