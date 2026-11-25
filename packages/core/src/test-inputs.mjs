import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

// Files whose edits can make a test pass without fixing the code: the tests
// themselves, fixtures, snapshots, mocks, setup files and runner configuration.
// The CLI and the hosted verification both use these rules, so a fix commit is
// judged the same way wherever it is verified.

const javascriptTestInput = [
  /\.(?:test|spec|fixture)\.[cm]?[jt]sx?$/i,
  /(?:^|\/)(?:__(?:tests|fixtures|snapshots|mocks)__|tests?|fixtures?)\//i,
  /\.snap$/i,
  // Runner configuration and workspaces.
  /(?:^|\/)(?:vitest|vite|jest)\.(?:config|workspace)(?:\.[^/]+)?\.(?:[cm]?[jt]s|json)$/i,
  /(?:^|\/)vitest\.(?:projects?)\.[cm]?[jt]s$/i,
  // Setup files that run before every test.
  /(?:^|\/)(?:setup-?tests?|tests?-?setup|(?:vitest|jest)[.-]setup(?:[.-][^/]+)?)\.[cm]?[jt]sx?$/i,
  /\.setup\.[cm]?[jt]sx?$/i,
];

const pytestTestInput =
  /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.py|conftest\.py|pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|requirements[^/]*\.txt)$/;

/** True for JavaScript test inputs: tests, fixtures, snapshots, mocks, setup and runner config. */
export const isJavaScriptTestInput = (path) => javascriptTestInput.some((rule) => rule.test(path));

/** True for Pytest test inputs: test modules, conftest and Pytest or dependency configuration. */
export const isPytestInput = (path) => pytestTestInput.test(path);

/** True when a path is a test input for any supported runner. */
export const isTestInput = (path) => isJavaScriptTestInput(path) || isPytestInput(path);

/** The `--config`/`-c` file a runner script names, when it names one. */
export function scriptConfigPath(command) {
  const words = String(command).trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/^["']|["']$/g, "");
    const inline = word.match(/^(?:--config|-c)=(.+)$/);
    if (inline) return inline[1].replace(/^["']|["']$/g, "");
    if ((word === "--config" || word === "-c") && words[i + 1])
      return words[i + 1].replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * A digest of the runner configuration a JavaScript run used: the package
 * script that ran, the package.json `jest` key, and the contents of a config
 * file the script names. Two runs with different digests did not run the test
 * the same way, even when no file matched the test-input rules.
 */
export async function runnerConfigDigest({ root, directory, pkg, script }) {
  const command = String(pkg.scripts?.[script] ?? "");
  const configPath = scriptConfigPath(command);
  let config = null;
  if (configPath) {
    try {
      const file = await realpath(resolve(directory, configPath));
      const inside = relative(root, file);
      config =
        inside.startsWith("..") || isAbsolute(inside)
          ? "outside-repository"
          : createHash("sha256")
              .update(await readFile(file))
              .digest("hex");
    } catch {
      config = "missing";
    }
  }
  return createHash("sha256")
    .update(JSON.stringify({ script, command, jest: pkg.jest ?? null, configPath, config }))
    .digest("hex");
}

/**
 * The package.json a pair of runs disagrees about. Returns `changed` with the
 * package.json path when both runs recorded different runner configurations.
 * When only one run recorded one, `unknown` is true and a package.json listed
 * in `changedFiles` counts as changed, since it can't be ruled out.
 */
export function runnerConfigChange(baseline, candidate, directory = ".", changedFiles = []) {
  if (!baseline || !candidate) return { changed: [], unknown: false };
  const dir = String(directory || ".").replace(/\/+$/, "");
  const manifest = dir === "." || !dir ? "package.json" : dir + "/package.json";
  if (!baseline.runnerConfig || !candidate.runnerConfig) {
    const unknown = !!(baseline.runnerConfig || candidate.runnerConfig);
    // Without both digests, a changed package.json can't be ruled out.
    return { changed: unknown && changedFiles.includes(manifest) ? [manifest] : [], unknown };
  }
  if (baseline.runnerConfig === candidate.runnerConfig) return { changed: [], unknown: false };
  return { changed: [manifest], unknown: false };
}
