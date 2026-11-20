import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validPytestCase } from "../../core/src/pytest.mjs";
import { BlockedError, UsageError } from "./errors.mjs";
import {
  changedFiles,
  githubRepository,
  hasUncommittedChanges,
  repositoryRoot,
  resolveCommit,
} from "./git.mjs";
import { githubAuth, resolveActionsLink } from "./github.mjs";
import { readReceipt, receiptMarkdown, writeReceipt } from "./receipt.mjs";
import { runTest } from "./run.mjs";
import { compactFailure } from "./compact.mjs";
import { checkVerdict, EXIT, exitCodeFor, reproVerdict, verifyVerdict } from "./verdicts.mjs";
import { VERSION } from "./version.mjs";

const HELP = `traceyard ${VERSION}: prove a failing test is fixed, on your machine.

Usage:
  traceyard repro [test] [--at <sha> | --from <actions-url>]   Rerun the failing test at the exact commit
  traceyard check [test]                                       Run the test against your working tree
  traceyard verify [test] [--before <sha>] [--after <sha>]     Failed before, passes now, test untouched
  traceyard receipt [id]                                       Show the latest (or a given) receipt

Options:
  --case <name>      Pytest case to run, e.g. TestCart::test_total
  --json             Print one JSON object on stdout (see docs/CLI.md)
  --log              Include the last lines of test output
  --fetch            Allow git to fetch a commit that isn't in this clone
  --install          Install dependencies in your working tree if they're missing (check)
  --fresh            Ignore cached results for the same commit and test
  --timeout <sec>    Time limit for one test run (default 180)
  --repo <dir>       Repository to use (default: current directory)
  -h, --help         Show this help
  -v, --version      Show the version

Exit codes: 0 reproduced/passed/fixed, 1 failing, 2 needs review, 3 blocked, 64 usage error.`;

const options = {
  at: { type: "string" },
  from: { type: "string" },
  before: { type: "string" },
  after: { type: "string" },
  case: { type: "string" },
  json: { type: "boolean", default: false },
  log: { type: "boolean", default: false },
  fetch: { type: "boolean", default: false },
  install: { type: "boolean", default: false },
  fresh: { type: "boolean", default: false },
  timeout: { type: "string" },
  repo: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
};

const allowed = {
  repro: ["at", "from"],
  check: [],
  verify: ["before", "after"],
  receipt: [],
};

const MAX_FAILURES = 5;
const MAX_MESSAGE = 600;
const MAX_OUTPUT = 4000;

/** Agent-facing run shape: bounded so a whole result stays well under 1,500 tokens. */
function publicRun(role, run, { log }) {
  const compacted = run.failures.map((f) => ({ ...f, message: compactFailure(f.message) }));
  const failures = compacted
    .slice(0, MAX_FAILURES)
    .map(({ file, name, message }) => ({ file, name, message: message.slice(0, MAX_MESSAGE) }));
  return {
    role,
    commit: run.commit,
    workingTree: run.commit === null,
    status: run.status,
    counts: run.counts,
    failures,
    truncated:
      run.truncated ||
      run.failures.length > MAX_FAILURES ||
      compacted.some((f) => f.message.length > MAX_MESSAGE),
    durationMs: run.durationMs,
    cached: run.cached,
    dependencies: run.dependencies,
    message: run.message.slice(0, MAX_MESSAGE),
    ...(log ? { output: run.output.slice(-MAX_OUTPUT) } : {}),
  };
}

async function stateDirectory(root) {
  const dir = join(root, ".traceyard");
  await mkdir(dir, { recursive: true });
  // Keep local evidence out of commits without touching the project's .gitignore.
  await writeFile(join(dir, ".gitignore"), "*\n");
  return dir;
}

async function lastRepro(stateDir) {
  try {
    return JSON.parse(await readFile(join(stateDir, "last-repro.json"), "utf8"));
  } catch {
    return null;
  }
}

function testArgument(value, cwd, root) {
  if (!value) return null;
  const path = relative(root, resolve(cwd, value)).split("\\").join("/");
  if (!path || path.startsWith("..") || isAbsolute(path))
    throw new UsageError(`The test file ${value} is outside this repository.`);
  return path;
}

async function commitArgument(root, ref, flag, fetch) {
  if (!ref) return null;
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  const sha = await resolveCommit(root, ref);
  if (sha) return sha;
  if (/^[0-9a-f]{7,39}$/i.test(ref) && fetch)
    throw new UsageError(`Pass the full 40-character SHA for ${flag} so Traceyard can fetch it.`);
  throw new UsageError(
    `${flag} ${ref} is not a commit in this clone.` +
      (/^[0-9a-f]{7,40}$/i.test(ref) ? " Pass --fetch to download it." : ""),
  );
}

function text(result) {
  if (result.command === "receipt" && result.receipt?.markdown)
    return [result.receipt.markdown.trimEnd(), ...result.warnings.map((w) => "Note: " + w)].join(
      "\n",
    );
  const icon = { 0: "✔", 1: "✖", 2: "!", 3: "■" }[result.exitCode] ?? "✖";
  const lines = [`${icon} ${result.verdict}: ${result.summary}`];
  for (const run of result.runs) {
    const where = run.commit ? run.commit : "working tree";
    const counts = `${run.counts.passed} passed, ${run.counts.failed} failed, ${run.counts.skipped} skipped`;
    lines.push(
      `  ${run.role.padEnd(9)} ${where}  ${run.status.toLowerCase()} (${counts}, ${(run.durationMs / 1000).toFixed(1)}s${run.cached ? ", cached" : ""})`,
    );
    for (const failure of run.failures.slice(0, 3)) {
      lines.push(`    - ${failure.name}`);
      const lines = failure.message.split("\n").filter((l) => l.trim());
      // Prefer the assertion line (Pytest prints it after "E "), else the first line.
      const first = lines.find((l) => /^E\s/.test(l.trim())) ?? lines[0];
      if (first) lines.push(`      ${first.trim().slice(0, 200)}`);
    }
    if (run.output) lines.push("", run.output.trimEnd(), "");
  }
  if (result.changedTests?.length)
    lines.push(`  Test files changed: ${result.changedTests.join(", ")}`);
  if (result.receipt) lines.push(`  Receipt: ${result.receipt.markdownPath}`);
  for (const warning of result.warnings) lines.push(`  Note: ${warning}`);
  lines.push(`Next: ${result.next}`);
  return lines.join("\n");
}

function emit(result, json, io) {
  io.stdout(json ? JSON.stringify(result) : text(result));
  return result.exitCode;
}

/**
 * Entry point. Returns the process exit code. `io` lets tests capture output;
 * `env` and `fetcher` let tests run without real GitHub access.
 */
export async function main(argv, io = defaultIo(), { env = process.env, fetcher } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    return usage(error.message, argv.includes("--json"), io);
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(VERSION);
    return EXIT.OK;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command || command === "help") {
    io.stdout(HELP);
    return command || values.help ? EXIT.OK : EXIT.USAGE;
  }
  const json = values.json;
  try {
    if (!(command in allowed))
      throw new UsageError(`Unknown command "${command}". Run traceyard --help.`);
    for (const flag of ["at", "from", "before", "after"])
      if (values[flag] !== undefined && !allowed[command].includes(flag))
        throw new UsageError(`--${flag} doesn't apply to traceyard ${command}.`);
    if (rest.length > 1) throw new UsageError("Pass one test file at a time.");
    if (values.case !== undefined && !validPytestCase(values.case))
      throw new UsageError(
        "--case takes a Pytest case like TestCart::test_total, without the file path.",
      );
    const timeoutSeconds = values.timeout === undefined ? 180 : Number(values.timeout);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600)
      throw new UsageError("--timeout takes a whole number of seconds between 1 and 3600.");
    const cwd = await realpath(resolve(values.repo ?? process.cwd())).catch(() =>
      resolve(values.repo ?? process.cwd()),
    );
    const root = await repositoryRoot(cwd);
    if (!root) throw new UsageError("Run traceyard inside a git repository, or pass --repo <dir>.");
    const stateDir = await stateDirectory(root);
    const progress = json ? undefined : (message) => io.stderr(message);
    const context = {
      root,
      cwd,
      stateDir,
      values,
      testInput: rest[0],
      progress,
      timeoutMs: timeoutSeconds * 1000,
      env,
      fetcher,
    };
    const result = await { repro, check, verify, receipt }[command](context);
    return emit(
      { schemaVersion: 1, command, ...result, exitCode: exitCodeFor(result.verdict) },
      json,
      io,
    );
  } catch (error) {
    if (error instanceof UsageError)
      return usage(error.message, json, io, command in allowed ? command : null);
    if (error instanceof BlockedError)
      return emit(
        {
          schemaVersion: 1,
          command,
          verdict: "BLOCKED",
          exitCode: EXIT.BLOCKED,
          summary: error.message,
          next: "Fix what blocked the run, then rerun the same command.",
          test: null,
          runs: [],
          warnings: [],
        },
        json,
        io,
      );
    io.stderr(`traceyard: unexpected error: ${error?.stack ?? error}`);
    return EXIT.INTERNAL;
  }
}

function usage(message, json, io, command = null) {
  if (json)
    io.stdout(
      JSON.stringify({
        schemaVersion: 1,
        command,
        verdict: "ERROR",
        exitCode: EXIT.USAGE,
        summary: message,
        next: "Run traceyard --help for usage.",
        test: null,
        runs: [],
        warnings: [],
      }),
    );
  else io.stderr(`traceyard: ${message}`);
  return EXIT.USAGE;
}

function defaultIo() {
  return {
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n"),
  };
}

const runOptions = (ctx) => ({
  repo: ctx.root,
  stateDir: ctx.stateDir,
  fetch: ctx.values.fetch,
  fresh: ctx.values.fresh,
  timeoutMs: ctx.timeoutMs,
  progress: ctx.progress,
  env: ctx.env,
});

async function repro(ctx) {
  const { values, root } = ctx;
  if (values.at && values.from) throw new UsageError("Pass either --at or --from, not both.");
  const warnings = [];
  let testPath = testArgument(ctx.testInput, ctx.cwd, root);
  let commit;
  let source;
  if (values.from) {
    const link = await resolveActionsLink(values.from, await githubRepository(root), {
      auth: await githubAuth(ctx.env),
      fetcher: ctx.fetcher,
    });
    source = { jobUrl: link.jobUrl, commit: link.commit, mergeCommit: link.mergeCommit };
    commit = link.commit;
    if (link.mergeCommit)
      warnings.push("CI tested the pull request merge commit, not the branch head.");
    if (!testPath) {
      if (link.failingTests.length === 1) testPath = link.failingTests[0];
      else if (link.failingTests.length > 1)
        throw new UsageError(
          `This job has ${link.failingTests.length} failing test files. Pick one: ${link.failingTests.slice(0, 8).join(", ")}`,
        );
      else
        throw new UsageError("No failing test file was found in the job log. Pass the test path.");
    }
    if (!(await resolveCommit(root, commit)) && !values.fetch)
      throw new UsageError(
        `The commit CI tested (${commit}) isn't in this clone. Pass --fetch to download it.`,
      );
  } else {
    commit = await commitArgument(root, values.at ?? "HEAD", "--at", values.fetch);
  }
  if (!testPath)
    throw new UsageError("Pass the test file to reproduce, e.g. traceyard repro src/cart.test.ts");
  if (!values.at && !values.from && (await hasUncommittedChanges(root)))
    warnings.push("Ran the last commit (HEAD). Your uncommitted changes were not included.");
  const run = await runTest({ ...runOptions(ctx), commit, testPath, testCase: values.case });
  const verdict = reproVerdict(run, testPath, { fromCi: Boolean(source) });
  if (run.status !== "BLOCKED")
    await writeFile(
      join(ctx.stateDir, "last-repro.json"),
      JSON.stringify(
        { test: testPath, case: values.case ?? null, commit: run.commit, verdict: verdict.verdict },
        null,
        2,
      ),
    );
  return {
    ...verdict,
    test: { path: testPath, case: values.case ?? null },
    runs: [publicRun("repro", run, values)],
    ...(source ? { source } : {}),
    warnings,
  };
}

async function defaultTest(ctx) {
  const explicit = testArgument(ctx.testInput, ctx.cwd, ctx.root);
  const last = await lastRepro(ctx.stateDir);
  if (explicit) return { path: explicit, case: ctx.values.case ?? null, last };
  if (!last?.test)
    throw new UsageError(
      "Pass the test file, or run `traceyard repro <test>` first so Traceyard remembers it.",
    );
  return { path: last.test, case: ctx.values.case ?? last.case ?? null, last };
}

async function check(ctx) {
  const test = await defaultTest(ctx);
  const run = await runTest({
    ...runOptions(ctx),
    commit: null,
    testPath: test.path,
    testCase: test.case ?? undefined,
    install: ctx.values.install,
  });
  return {
    ...checkVerdict(run, test.path),
    test: { path: test.path, case: test.case },
    runs: [publicRun("check", run, ctx.values)],
    warnings: [],
  };
}

async function verify(ctx) {
  const { values, root } = ctx;
  const test = await defaultTest(ctx);
  const sameTest =
    test.last && test.last.test === test.path && (test.last.case ?? null) === test.case;
  const beforeRef =
    values.before ?? (sameTest && test.last.verdict === "REPRODUCED" ? test.last.commit : null);
  if (!beforeRef)
    throw new UsageError(
      "Pass --before <sha> (the commit where the test failed), or run `traceyard repro` for this test first.",
    );
  const before = await commitArgument(root, beforeRef, "--before", values.fetch);
  const after = await commitArgument(root, values.after ?? "HEAD", "--after", values.fetch);
  const warnings = [];
  if (!values.after && (await hasUncommittedChanges(root)))
    warnings.push(
      "Verified the last commit (HEAD). Commit your changes first if they are part of the fix.",
    );
  const testCase = test.case ?? undefined;
  const baseline = await runTest({
    ...runOptions(ctx),
    commit: before,
    testPath: test.path,
    testCase,
  });
  const candidate =
    baseline.status === "FAILED"
      ? await runTest({ ...runOptions(ctx), commit: after, testPath: test.path, testCase })
      : null;
  const files = candidate ? await changedFiles(root, before, after) : [];
  const verdict = verifyVerdict({
    baseline,
    candidate: candidate ?? baseline,
    testPath: test.path,
    changedFiles: files,
  });
  const runs = [publicRun("baseline", baseline, values)];
  if (candidate) runs.push(publicRun("candidate", candidate, values));
  let receiptInfo;
  if (candidate && verdict.verdict !== "BLOCKED") {
    const written = await writeReceipt(ctx.stateDir, {
      repository: await githubRepository(root),
      test: { path: test.path, case: test.case },
      verdict,
      baseline,
      candidate,
    });
    receiptInfo = {
      id: written.receipt.id,
      path: relative(root, written.jsonPath).split("\\").join("/"),
      markdownPath: relative(root, written.markdownPath).split("\\").join("/"),
    };
  }
  return {
    verdict: verdict.verdict,
    summary: verdict.summary,
    next: verdict.next,
    test: { path: test.path, case: test.case },
    runs,
    changedTests: verdict.changedTests,
    ...(receiptInfo ? { receipt: receiptInfo } : {}),
    warnings,
  };
}

async function receipt(ctx) {
  const id = ctx.testInput;
  const found = await readReceipt(ctx.stateDir, id);
  if (!found)
    throw new UsageError(
      id
        ? `No receipt ${id} in .traceyard/receipts.`
        : "No receipts yet. Run `traceyard verify` first.",
    );
  const r = found.receipt;
  const warnings = found.intact
    ? []
    : ["This receipt was edited after it was written. Its digest doesn't match."];
  return {
    verdict: found.intact ? r.verdict : "INCONCLUSIVE",
    summary: r.summary,
    next: "Paste the Markdown receipt into your pull request.",
    test: r.test,
    runs: [],
    receipt: {
      id: r.id,
      path: relative(ctx.root, found.jsonPath).split("\\").join("/"),
      markdownPath: relative(ctx.root, found.jsonPath.replace(/\.json$/, ".md"))
        .split("\\")
        .join("/"),
      intact: found.intact,
      body: ctx.values.json ? r : undefined,
      markdown: ctx.values.json ? undefined : receiptMarkdown(r),
    },
    warnings,
  };
}
