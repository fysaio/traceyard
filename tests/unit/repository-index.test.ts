import { describe, expect, it } from "vitest";
import { analyzeRepositoryFiles, relatedTests } from "../../packages/core/src/repository-index.mjs";
import {
  indexedFileSchema,
  repositoryPackageSchema,
} from "../../shared/contracts/repository-index";
const files = [
  {
    path: "package.json",
    content: JSON.stringify({
      name: "fixture",
      scripts: { test: "vitest run", dev: "SECRET=private-value node app.js" },
    }),
  },
  { path: "package-lock.json", content: '{"lockfileVersion":3}' },
  {
    path: "tsconfig.json",
    content: JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
  },
  { path: "src/db.ts", content: "export function load(){return 1}" },
  { path: "src/service.ts", content: "import {load} from './db.js'; export const work=()=>load()" },
  {
    path: "test/service.test.ts",
    content: "import {work} from '@/service'; describe('service',()=>{it('loads',()=>work())})",
  },
];
describe("repository and test index", () => {
  it("resolves transitive local/alias imports and discovers existing tests without exposing source literals", () => {
    const index = analyzeRepositoryFiles(files);
    expect(index.packages[0]?.testRunner).toBe("vitest");
    expect(index.packages.every((p) => repositoryPackageSchema.safeParse(p).success)).toBe(true);
    expect(index.files.every((f) => indexedFileSchema.safeParse(f).success)).toBe(true);
    expect(relatedTests(index, "src/db.ts").map((f) => f.path)).toEqual(["test/service.test.ts"]);
    expect(index.files.find((f) => f.isTest)?.tests.map((t) => t.name)).toEqual([
      "service",
      "loads",
    ]);
    expect(JSON.stringify(index)).not.toContain("private-value");
  });
  it("invalidates content identity when source or lockfile changes and preserves unresolved boundaries", () => {
    const a = analyzeRepositoryFiles(files),
      b = analyzeRepositoryFiles(
        files.map((f) =>
          f.path === "package-lock.json"
            ? { ...f, content: '{"lockfileVersion":3,"changed":true}' }
            : f,
        ),
      );
    expect(a.snapshotId).not.toBe(b.snapshotId);
    expect(a.packages[0]?.lockHash).not.toBe(b.packages[0]?.lockHash);
    const missing = analyzeRepositoryFiles([
      { path: "app.ts", content: "import {x} from 'unknown-library'; x()" },
    ]);
    expect(missing.files[0]?.imports[0]?.resolved).toBeNull();
  });
  it("does not resolve another workspace's private aliases", () => {
    const index = analyzeRepositoryFiles([
      {
        path: "apps/a/tsconfig.json",
        content: '{"compilerOptions":{"baseUrl":"src","paths":{"@/*":["*"]}}}',
      },
      { path: "apps/a/src/db.ts", content: "export const x=1" },
      { path: "apps/b/service.ts", content: "import {x} from '@/db'" },
    ]);
    expect(
      index.files.find((f) => f.path === "apps/b/service.ts")?.imports[0]?.resolved,
    ).toBeNull();
  });
  it("handles cyclic imports and reports parse limitations without inventing relationships", () => {
    const index = analyzeRepositoryFiles([
      { path: "a.ts", content: "import './b'" },
      { path: "b.ts", content: "import './a'" },
      { path: "a.test.ts", content: "import './a';test('works',()=>{})" },
      { path: "broken.ts", content: "export (" },
    ]);
    expect(relatedTests(index, "a.ts")).toHaveLength(1);
    expect(index.coverage.warnings).toContain("Cannot parse source: broken.ts");
  });
});
