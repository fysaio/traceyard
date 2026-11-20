import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validPytestCase } from "../../core/src/pytest.mjs";
import { BlockedError, UsageError } from "./errors.mjs";
import {
  changedFiles,
  githubRepository,
  headCommit,
  showFile,
  hasUncommittedChanges,
  repositoryRoot,
  resolveCommit,
} from "./git.mjs";
import { githubAuth, resolveActionsLink } from "./github.mjs";
import { listReceipts, readReceipt, receiptMarkdown, writeReceipt } from "./receipt.mjs";
import { cacheDirectory, listEvidence, readEvidence, runTest } from "./run.mjs";
import { cleanOutput, compactFailure } from "./compact.mjs";
import {
  checkVerdict,
  EXIT,
  exitCodeFor,
  guardVerdict,
  reproVerdict,
  verifyVerdict,
} from "./verdicts.mjs";
import { VERSION } from "./version.mjs";

const HELP = `traceyard ${VERSION}: prove a failing test is fixed, on your machine.

Usage:
  traceyard repro [test] [--at <sha> | --from <actions-url>]   Rerun the failing test at the exact commit
  traceyard check [test]                                       Run the test against your working tree
  traceyard verify [test] [--before <sha>] [--after <sha>]     Failed before, passes now, test untouched
  traceyard guard [receipt]                                    Exit 0 only if HEAD has an intact FIXED receipt
  traceyard explain [evidence] [--failure <n>]                 The failure, where it happened, and the source there
  traceyard inspect [evidence] [--offset <n>] [--limit <n>]    Recent runs, or one run's full log in slices
  traceyard receipt [id]                                       Show the latest (or a given) receipt
  traceyard mcp                                                Serve these tools to coding agents over MCP (stdio)

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

Exit codes: 0 reproduced/passed/fixed, 1 failing/unverified, 2 needs review, 3 blocked, 64 usage error.`;

const options = {
  at: { type: "string" },
  from: { type: "string" },
  before: { type: "string" },
  after: { type: "string" },
  case: { type: "string" },
  failure: { type: "string" },
  offset: { type: "string" },
  limit: { type: "string" },
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

const defaults = { json: false, log: false, fetch: false, install: false, fresh: false };

/** Flags that only make sense for some commands. Everything else applies everywhere. */
const allowed = {
  repro: ["at", "from", "case"],
  check: ["case"],
  verify: ["before", "after", "case"],
  guard: [],
  explain: ["failure"],
  inspect: ["offset", "limit"],
  receipt: [],
};
const commandFlags = ["at", "from", "before", "after", "case", "failure", "offset", "limit"];

const MAX_FAILURES = 5;
const MAX_MESSAGE = 600;
const MAX_OUTPUT = 4000;
const SLICE_DEFAULT = 3000;
const SLICE_MAX = 4000;

/** Agent-facing run shape: bounded so a whole result stays well under 1,500 tokens. */
function publicRun(role, run, { log }, root) {
  const compacted = run.failures.map((f) => ({ ...f, message: compactFailure(f.message, root) }));
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
    evidenceId: run.evidenceId ?? null,
    message: cleanOutput(run.message, root).slice(0, MAX_MESSAGE),
    ...(log ? { output: cleanOutput(run.output, root).slice(-MAX_OUTPUT) } : {}),
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
      const messageLines = failure.message.split("\n").filter((l) => l.trim());
      // Prefer the assertion line (Pytest prints it after "E "), else the first line.
      const first = messageLines.find((l) => /^E\s/.test(l.trim())) ?? messageLines[0];
      if (first) lines.push(`      ${first.trim().slice(0, 200)}`);
    }
    if (run.output) lines.push("", run.output.trimEnd(), "");
  }
  if (result.explanation) {
    const { failure, location, source } = result.explanation;
    lines.push(`  Failure ${failure.index} of ${failure.of}: ${failure.name}`);
    if (location) lines.push(`  At ${location.path}:${location.line}`);
    lines.push("", failure.message.trimEnd());
    if (source) lines.push("", source.text);
    lines.push("");
  }
  if (result.items)
    for (const item of result.items)
      lines.push(
        `  ${item.kind.padEnd(8)} ${item.id}  ${String(item.status).toLowerCase()}  ${item.test ?? ""}${item.commit ? " @ " + item.commit.slice(0, 12) : ""}`,
      );
  if (result.evidence) lines.push("", result.evidence.text.trimEnd(), "");
  if (result.changedTests?.length)
    lines.push(`  Test files changed: ${result.changedTests.join(", ")}`);
  if (result.receipt) lines.push(`  Receipt: ${result.receipt.markdownPath}`);
  for (const warning of result.warnings) lines.push(`  Note: ${warning}`);
  lines.push(`Next: ${result.next}`);
  return lines.join("\n");
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
    return emit(usageResult(error.message, null), argv.includes("--json"), io);
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
  if (command === "mcp") {
    if (rest.length) return emit(usageResult("traceyard mcp takes no arguments.", null), false, io);
    const { serveMcp } = await import("./mcp.mjs");
    await serveMcp({ repo: values.repo, env, fetcher });
    return EXIT.OK;
  }
  if (rest.length > 1)
    return emit(
      usageResult("Pass one test file at a time.", knownCommand(command)),
      values.json,
      io,
    );
  const progress = values.json ? undefined : (message) => io.stderr(message);
  const result = await execute(command, values, rest[0], { env, fetcher, progress });
  if (result.exitCode === EXIT.INTERNAL) {
    io.stderr(`traceyard: unexpected error: ${result.summary}`);
    return EXIT.INTERNAL;
  }
  return emit(result, values.json, io);
}

const knownCommand = (command) => (command in allowed ? command : null);

/**
 * Run one command and return its result object. Shared by the command line and
 * the MCP server, so both always agree. Never throws: usage problems become
 * ERROR, unexpected failures become exit code 70.
 */
export async function execute(
  command,
  input = {},
  testInput,
  { env = process.env, fetcher, progress } = {},
) {
  const values = { ...defaults, ...input };
  try {
    if (!(command in allowed))
      throw new UsageError(`Unknown command "${command}". Run traceyard --help.`);
    for (const flag of commandFlags)
      if (values[flag] !== undefined && !allowed[command].includes(flag))
        throw new UsageError(`--${flag} doesn't apply to traceyard ${command}.`);
    if (values.case !== undefined && !validPytestCase(values.case))
      throw new UsageError(
        "--case takes a Pytest case like TestCart::test_total, without the file path.",
      );
    const timeoutSeconds = values.timeout === undefined ? 180 : Number(values.timeout);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600)
      throw new UsageError("--timeout takes a whole number of seconds between 1 and 3600.");
    for (const flag of ["offset", "limit", "failure"])
      if (values[flag] !== undefined && !/^\d+$/.test(String(values[flag])))
        throw new UsageError(`--${flag} takes a whole number.`);
    const cwd = await realpath(resolve(values.repo ?? process.cwd())).catch(() =>
      resolve(values.repo ?? process.cwd()),
    );
    const root = await repositoryRoot(cwd);
    if (!root) throw new UsageError("Run traceyard inside a git repository, or pass --repo <dir>.");
    const stateDir = await stateDirectory(root);
    const context = {
      root,
      cwd,
      stateDir,
      values,
      testInput,
      progress,
      timeoutMs: timeoutSeconds * 1000,
      env,
      fetcher,
    };
    const result = await handlers[command](context);
    return { schemaVersion: 1, command, ...result, exitCode: exitCodeFor(result.verdict) };
  } catch (error) {
    if (error instanceof UsageError) return usageResult(error.message, knownCommand(command));
    if (error instanceof BlockedError)
      return {
        schemaVersion: 1,
        command,
        verdict: "BLOCKED",
        exitCode: EXIT.BLOCKED,
        summary: error.message,
        next: "Fix what blocked the run, then rerun the same command.",
        test: null,
        runs: [],
        warnings: [],
      };
    return {
      schemaVersion: 1,
      command: knownCommand(command),
      verdict: "ERROR",
      exitCode: EXIT.INTERNAL,
      summary: String(error?.stack ?? error),
      next: "This is a bug in Traceyard. Please report it with the command you ran.",
      test: null,
      runs: [],
      warnings: [],
    };
  }
}

function usageResult(message, command) {
  return {
    schemaVersion: 1,
    command,
    verdict: "ERROR",
    exitCode: EXIT.USAGE,
    summary: message,
    next: "Run traceyard --help for usage.",
    test: null,
    runs: [],
    warnings: [],
  };
}

function emit(result, json, io) {
  if (json) io.stdout(JSON.stringify(result));
  else if (result.verdict === "ERROR") io.stderr(`traceyard: ${result.summary}`);
  else io.stdout(text(result));
  return result.exitCode;
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
  cacheDir: cacheDirectory(ctx.env),
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
    runs: [publicRun("repro", run, values, root)],
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
    runs: [publicRun("check", run, ctx.values, ctx.root)],
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
  const runs = [publicRun("baseline", baseline, values, root)];
  if (candidate) runs.push(publicRun("candidate", candidate, values, root));
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
      // Agents get the Markdown to paste into a pull request; --json gets the full body.
      body: ctx.values.json && !ctx.values.agent ? r : undefined,
      markdown: ctx.values.json && !ctx.values.agent ? undefined : receiptMarkdown(r),
    },
    warnings,
  };
}

/**
 * A merge gate: passes only when HEAD is the fix commit of an intact FIXED
 * receipt. Use it in a pre-push hook or as the last step an agent runs.
 */
async function guard(ctx) {
  const found = await readReceipt(ctx.stateDir, ctx.testInput);
  if (ctx.testInput && !found)
    throw new UsageError(`No receipt ${ctx.testInput} in .traceyard/receipts.`);
  const head = await headCommit(ctx.root);
  const warnings = [];
  if (await hasUncommittedChanges(ctx.root))
    warnings.push("You have uncommitted changes. The guard checks the last commit (HEAD) only.");
  const verdict = guardVerdict({
    receipt: found?.receipt ?? null,
    intact: found?.intact ?? false,
    head,
  });
  return {
    ...verdict,
    test: found?.receipt.test ?? null,
    runs: [],
    ...(found
      ? {
          receipt: {
            id: found.receipt.id,
            path: relative(ctx.root, found.jsonPath).split("\\").join("/"),
            markdownPath: relative(ctx.root, found.jsonPath.replace(/\.json$/, ".md"))
              .split("\\")
              .join("/"),
            intact: found.intact,
          },
        }
      : {}),
    warnings,
  };
}

async function latestEvidenceId(ctx) {
  const last = await readJson(join(ctx.stateDir, "last-evidence.json"));
  if (last?.evidenceId) return last.evidenceId;
  return (await listEvidence(ctx.stateDir, 1))[0]?.evidenceId ?? null;
}

async function evidenceFor(ctx) {
  const id = ctx.testInput ?? (await latestEvidenceId(ctx));
  if (!id) throw new UsageError("No runs yet. Run `traceyard repro` or `traceyard check` first.");
  const run = await readEvidence(ctx.stateDir, id);
  if (!run)
    throw new UsageError(
      `No run ${id} in .traceyard/runs. Run \`traceyard inspect\` to list runs.`,
    );
  return run;
}

// A path:line[:column] reference to a JavaScript, TypeScript or Python file.
const LOCATION = /(?:^|[\s(])((?:[\w@.+-]+\/)*[\w@.+-]+\.(?:[cm]?[jt]sx?|py)):(\d+)(?::(\d+))?/m;

/** Where the failure points: the first file:line in the message that exists in the repository. */
async function failureLocation(ctx, run, message) {
  for (const line of message.split("\n")) {
    const match = line.match(LOCATION);
    if (!match || /node_modules|site-packages/.test(match[1])) continue;
    const source = await showFile(ctx.root, run.commit, match[1]);
    if (source === null) continue;
    return {
      path: match[1],
      line: Number(match[2]),
      column: match[3] ? Number(match[3]) : null,
      source,
    };
  }
  return null;
}

/** The first failure in a run, where it happened, and the source lines around it. */
async function explain(ctx) {
  const run = await evidenceFor(ctx);
  const index = Math.max(1, Number(ctx.values.failure ?? 1));
  const failure = run.failures[index - 1];
  const base = {
    test: run.test ?? null,
    runs: [publicRun(run.commit ? "repro" : "check", { ...run, cached: true }, {}, ctx.root)],
    warnings: [],
  };
  if (!failure)
    return {
      verdict: "AVAILABLE",
      summary: run.failures.length
        ? `Run ${run.evidenceId} has ${run.failures.length} failure(s); there is no failure ${index}.`
        : `Run ${run.evidenceId} has no failures: ${run.status.toLowerCase()}.`,
      next: run.failures.length
        ? `Pass a failure number from 1 to ${run.failures.length}.`
        : "Nothing to explain. Run `traceyard inspect` for its log.",
      ...base,
    };
  const message = compactFailure(failure.message, ctx.root);
  const location = await failureLocation(ctx, run, message);
  let excerpt = null;
  if (location) {
    const lines = location.source.split("\n");
    const start = Math.max(1, location.line - 6);
    const end = Math.min(lines.length, location.line + 6);
    excerpt = {
      path: location.path,
      commit: run.commit,
      startLine: start,
      text: lines
        .slice(start - 1, end)
        .map(
          (l, i) =>
            `${String(start + i).padStart(5)}${start + i === location.line ? " >" : "  "} ${l}`,
        )
        .join("\n")
        .slice(0, 1600),
    };
  }
  return {
    verdict: "AVAILABLE",
    summary: `${failure.name} failed${location ? ` at ${location.path}:${location.line}` : ""}.`,
    next: run.commit
      ? "Fix the code, not the test, then run `traceyard check`."
      : "Change the code and run `traceyard check` again.",
    ...base,
    explanation: {
      evidenceId: run.evidenceId,
      failure: {
        index,
        of: run.failures.length,
        file: failure.file,
        name: failure.name,
        message: message.slice(0, 2000),
      },
      location: location
        ? { path: location.path, line: location.line, column: location.column }
        : null,
      source: excerpt,
    },
  };
}

/** Without an ID: recent runs and receipts. With one: that run's log, in bounded slices. */
async function inspect(ctx) {
  if (!ctx.testInput) {
    const runs = await listEvidence(ctx.stateDir, 8);
    const receipts = await listReceipts(ctx.stateDir, 5);
    return {
      verdict: "AVAILABLE",
      summary: `${runs.length} recent run(s) and ${receipts.length} receipt(s) in .traceyard.`,
      next: runs.length
        ? "Pass an evidence ID to read its log, or use `traceyard explain <id>`."
        : "Run `traceyard repro <test>` first.",
      test: null,
      runs: [],
      items: [
        ...runs.map((r) => ({
          kind: "run",
          id: r.evidenceId,
          test: r.test?.path ?? null,
          commit: r.commit,
          status: r.status,
          recordedAt: r.recordedAt ?? null,
        })),
        ...receipts.map((r) => ({
          kind: "receipt",
          id: r.id,
          test: r.test?.path ?? null,
          commit: r.candidate?.commit ?? null,
          status: r.verdict,
          recordedAt: r.createdAt ?? null,
        })),
      ],
      warnings: [],
    };
  }
  if (ctx.testInput.startsWith("rcpt_")) return receipt(ctx);
  const run = await evidenceFor(ctx);
  const output = cleanOutput(run.output ?? "", ctx.root);
  const offset = Math.min(Number(ctx.values.offset ?? 0), output.length);
  const limit = Math.min(SLICE_MAX, Math.max(200, Number(ctx.values.limit ?? SLICE_DEFAULT)));
  const slice = output.slice(offset, offset + limit);
  const nextOffset = offset + slice.length < output.length ? offset + slice.length : null;
  return {
    verdict: "AVAILABLE",
    summary: output.length
      ? `Characters ${offset}-${offset + slice.length} of ${output.length} from run ${run.evidenceId}.`
      : `Run ${run.evidenceId} recorded no output.`,
    next:
      nextOffset === null
        ? "That is the end of the log."
        : `Pass --offset ${nextOffset} for the next slice.`,
    test: run.test ?? null,
    runs: [],
    evidence: {
      id: run.evidenceId,
      offset,
      nextOffset,
      total: output.length,
      text: slice,
    },
    warnings: [],
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Remember the run an agent most likely wants to explain next: the last failing one. */
async function rememberEvidence(stateDir, runs) {
  const run =
    runs.findLast((r) => r.evidenceId && r.status === "FAILED") ??
    runs.findLast((r) => r.evidenceId);
  if (run)
    await writeFile(
      join(stateDir, "last-evidence.json"),
      JSON.stringify({ evidenceId: run.evidenceId }, null, 2),
    );
}

const remembering = (handler) => async (ctx) => {
  const result = await handler(ctx);
  await rememberEvidence(ctx.stateDir, result.runs ?? []);
  return result;
};

const handlers = {
  repro: remembering(repro),
  check: remembering(check),
  verify: remembering(verify),
  guard,
  explain,
  inspect,
  receipt,
};
