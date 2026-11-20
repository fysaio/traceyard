// @traceyard/core: run one test at an exact commit, locally, with no server and
// no network. The hosted runner and the CLI are both thin layers over this.
import { indexRepository } from "./repository-index.mjs";
import { runInvestigationPlan, runTargetedTest } from "./test-evidence.mjs";
import { withCommit } from "./worktree.mjs";

export { analyzeRepositoryFiles, indexRepository, relatedTests } from "./repository-index.mjs";
export {
  normalizeVitestReport,
  prepareTargetedTest,
  runInvestigationPlan,
  runTargetedTest,
  sanitizeDiagnostic,
  selectTest,
} from "./test-evidence.mjs";
export { discoverFile } from "./discovery.mjs";
export { summarizeCommandFailure } from "./failure-summary.mjs";
export { isPytestFile, validPytestCase } from "./pytest.mjs";
export { adapterForFile, adapterForScript, runnerAdapters } from "./runners.mjs";
export {
  detectPackageManager,
  installCommand,
  parsePackageManagerField,
  scriptCommand,
} from "./package-manager.mjs";
export { failingTestsFromLog, parseActionsUrl, readCheckoutRevision } from "./ci-link.mjs";
export { checkoutCommit, ensureCommit, githubFetchEnv, withCommit } from "./worktree.mjs";

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Run one test file (optionally one Pytest case) and return a structured result.
 * With `commit`, the test runs in a throwaway worktree at that exact SHA and the
 * developer's working tree is left alone. Dependencies must already be
 * installable or installed; installing is the caller's decision.
 */
export async function runLocalTest({
  repo,
  testPath,
  testCase,
  question = "",
  commit,
  changedFiles,
  maxTestFiles = 1,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  packageManager,
  fetch = false,
  token,
  beforeRun,
}) {
  if (!repo) throw Error("Pass the repository directory as `repo`.");
  const plan = { question, testPath, testCase, timeoutMs, changedFiles, maxTestFiles };
  const run = async (directory, sha) => {
    if (beforeRun) await beforeRun(directory);
    const index = await indexRepository(directory);
    const options = packageManager ? { packageManager } : {};
    const report =
      changedFiles?.length || maxTestFiles > 1
        ? await runInvestigationPlan(directory, index, plan, env, options)
        : await runTargetedTest(directory, index, plan, env, options);
    return { ...report, commit: sha ?? null, snapshotId: index.snapshotId };
  };
  if (!commit) return run(repo);
  return withCommit(repo, commit, (checkout) => run(checkout.path, checkout.sha), {
    fetch,
    token,
  });
}
export * from "./agent-result.mjs";
