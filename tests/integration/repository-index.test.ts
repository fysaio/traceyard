import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getOrCreateGitHubIdentity, createUserSession } from "../../worker/persistence/identity";
import { getDefaultProjectId } from "../../worker/persistence/projects";
import { analyzeRepositoryFiles } from "../../agent/repository-index.mjs";
import {
  beginRepositoryIndex,
  uploadRepositoryIndexFiles,
  completeRepositoryIndex,
  getRepositoryIndex,
} from "../../worker/services/repository-index-service";
import { ORIGIN } from "./helpers";
async function account(id = 980) {
  const user = await getOrCreateGitHubIdentity(env.DB, {
    id,
    login: `index-${id}`,
    name: "Owner",
    avatarUrl: null,
  });
  await createUserSession(env.DB, user.id, new Request(ORIGIN));
  return { userId: user.id, projectId: (await getDefaultProjectId(env.DB, user.id))! };
}
describe("immutable repository index", () => {
  it("hides incomplete uploads, discovers transitive tests and isolates ownership", async () => {
    const a = await account(),
      other = await account(981);
    const index = analyzeRepositoryFiles([
      { path: "package.json", content: '{"scripts":{"test":"vitest run"}}' },
      { path: "src/db.ts", content: "export const x=1" },
      { path: "src/service.ts", content: "import './db'" },
      { path: "tests/service.test.ts", content: "import '../src/service'; test('loads',()=>{})" },
    ]);
    await beginRepositoryIndex(env.DB, a.projectId, {
      snapshotId: index.snapshotId,
      commit: "a".repeat(40),
      packages: index.packages,
      fileCount: index.files.length,
      coverage: index.coverage,
    });
    expect(await getRepositoryIndex(env.DB, a.userId, a.projectId)).toBeNull();
    await expect(completeRepositoryIndex(env.DB, a.projectId, index.snapshotId)).rejects.toThrow(
      "every declared file",
    );
    await uploadRepositoryIndexFiles(env.DB, a.projectId, index.snapshotId, index.files);
    await uploadRepositoryIndexFiles(env.DB, a.projectId, index.snapshotId, index.files);
    await completeRepositoryIndex(env.DB, a.projectId, index.snapshotId);
    const result = await getRepositoryIndex(env.DB, a.userId, a.projectId, "src/db.ts");
    expect(result?.relatedTests.map((t) => t.path)).toEqual(["tests/service.test.ts"]);
    expect(
      await getRepositoryIndex(env.DB, a.userId, a.projectId, undefined, "b".repeat(40)),
    ).toBeNull();
    await expect(getRepositoryIndex(env.DB, other.userId, a.projectId)).rejects.toThrow(
      "Project not found",
    );
    await expect(
      uploadRepositoryIndexFiles(env.DB, a.projectId, index.snapshotId, [
        { ...index.files[0]!, hash: "b".repeat(64) },
      ]),
    ).rejects.toThrow("cannot be replaced");
  });
});
