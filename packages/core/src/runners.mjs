import { relative, resolve } from "node:path";
import {
  isPytestFile,
  normalizePytestEvidence,
  preparePytest,
  pytestArgs,
  pytestEnvironment,
} from "./pytest.mjs";
import { normalizeVitestReport } from "./test-report.mjs";

/**
 * A runner adapter turns "run this one test file" into a process and turns that
 * process's structured report into Traceyard's result shape.
 *
 * @typedef {object} RunnerAdapter
 * @property {"vitest" | "jest" | "pytest"} name
 * @property {"javascript" | "python"} language
 * @property {{ replay: boolean, retryControl: boolean, caseSelector: boolean }} supports
 * @property {(command: string) => boolean} [matchesScript] package.json script detection (JS only)
 * @property {(path: string) => boolean} [matchesFile] test file detection (Python only)
 * @property {(input: { testArgument: string, output: string, plan: object }) => string[]} args
 *   Arguments for the runner; JS adapters receive them after the package script.
 * @property {(env: Record<string, string | undefined>) => Record<string, string | undefined>} [environment]
 * @property {(data: unknown, exitCode: number | null, context: { root: string, directory: string, file: string, command: object }) => object} normalize
 *   Throws or returns `{ blocked }` when the report cannot be trusted.
 */

const scriptPattern =
  /^(?:vitest|jest)(?=\s|$)|^node\s+["']?[^\r\n]*?[\\/](vitest\.mjs|jest\.js)["']?(?=\s|$)/;

function scriptRunner(command) {
  const match = String(command).trim().match(scriptPattern);
  if (!match) return null;
  return match[0] === "jest" || match[1] === "jest.js" ? "jest" : "vitest";
}

function normalizeJsReport(data, exitCode, { root, directory, file }) {
  if (!Array.isArray(data?.testResults) || !data.testResults.length)
    return { blocked: "The test runner did not report a result for the selected file." };
  if (data.testResults.some(({ name }) => relative(file, resolve(directory, String(name)))))
    return { blocked: "The test script reported files outside the selected test." };
  return normalizeVitestReport(data, exitCode, root);
}

/** @type {Record<string, RunnerAdapter>} */
export const runnerAdapters = {
  vitest: {
    name: "vitest",
    language: "javascript",
    supports: { replay: true, retryControl: true, caseSelector: false },
    matchesScript: (command) => scriptRunner(command) === "vitest",
    args: ({ testArgument, output, plan }) => [
      "--run",
      "--reporter=json",
      ...(plan.flakeCandidate ? ["--retry=0"] : []),
      testArgument,
      "--outputFile=" + output,
    ],
    normalize: normalizeJsReport,
  },
  jest: {
    name: "jest",
    language: "javascript",
    supports: { replay: false, retryControl: false, caseSelector: false },
    matchesScript: (command) => scriptRunner(command) === "jest",
    args: ({ testArgument, output }) => [
      "--ci",
      "--watch=false",
      "--watchAll=false",
      "--runTestsByPath",
      "--json",
      testArgument,
      "--outputFile=" + output,
    ],
    normalize: normalizeJsReport,
  },
  pytest: {
    name: "pytest",
    language: "python",
    supports: { replay: false, retryControl: false, caseSelector: true },
    matchesFile: isPytestFile,
    prepare: preparePytest,
    args: ({ testArgument, output, plan }) =>
      pytestArgs(
        testArgument.startsWith("./") ? testArgument : "./" + testArgument,
        plan.testCase,
        output,
      ),
    environment: (env) => pytestEnvironment(env),
    normalize: (data, exitCode, { command }) => normalizePytestEvidence(data, exitCode, command),
  },
};

/** The JS adapter for a package.json script, or null for unsupported scripts. */
export function adapterForScript(command) {
  const name = scriptRunner(command);
  return name ? runnerAdapters[name] : null;
}

/** The adapter that owns a test file by path alone, when the path decides it. */
export function adapterForFile(path) {
  return Object.values(runnerAdapters).find((a) => a.matchesFile?.(path)) ?? null;
}
