# TraceYard CLI

Prove a failing test is fixed on your own machine. No TraceYard account or server is required. Test execution is local; dependency installation, optional Git fetching, and the initial package bootstrap can use the network when requested.

```bash
traceyard repro src/cart.test.ts --at 3f2c9e1   # fails at the commit CI tested
traceyard check                                 # run it against your edits, as often as you like
git commit -am "Fix cart rounding"
traceyard verify                                # failed before, passes now, test untouched
traceyard guard                                 # exit 0 only if HEAD is proven fixed
traceyard receipt                               # Markdown you can paste into the PR
```

Coding agents get the same commands as MCP tools with `traceyard mcp`. See [Coding agents](#coding-agents-mcp).

Released use is `npx traceyard@0.1.0` (or `npx traceyard` when you intentionally want the current latest). From a checkout, after `npm ci` and with Node.js 22.12.0 or newer, use `node packages/cli/bin/traceyard.mjs` for development.

## Commands

### `traceyard repro [test] [--at <sha> | --from <actions-url>]`

Runs the test at an exact commit in a throwaway `git worktree`. Your working tree, index and stash are never touched. `--at` defaults to `HEAD`.

`--from` takes a GitHub Actions run or job link. Traceyard reads the job log, finds the commit `actions/checkout` checked out, and picks the failing test file if the log names exactly one. It uses `GITHUB_TOKEN` or `GH_TOKEN` if set, then an authenticated `gh` CLI. Public repositories work without either. If the tested commit isn't in your clone (for example a pull request merge commit), add `--fetch`.

Traceyard remembers the test and commit, so `check` and `verify` can run without arguments afterwards.

### `traceyard check [test]`

Runs the test in your working tree, including uncommitted edits. This is the fast loop for each attempt at a fix. It never writes a receipt, because uncommitted code can't be pinned to a commit.

### `traceyard verify [test] [--before <sha>] [--after <sha>]`

Runs the test at the failing commit (`--before`, default: the last reproduced commit) and at the fix commit (`--after`, default `HEAD`). It compares the files changed between them. The verdict is `FIXED` only when all of these are true:

1. The test failed at `--before`.
2. The same test file passed at `--after`, with at least one passing test and no extra skips.
3. No tests, fixtures, snapshots, mocks, setup files or test runner config changed between the two commits. A change to the test script, the `jest` key in `package.json`, or a config file the script names counts as a runner config change. See [execution trust](EXECUTION_TRUST.md#test-inputs).

Each verify writes a receipt to `.traceyard/receipts/` as JSON and Markdown.

### `traceyard guard [receipt]`

A merge gate for scripts, hooks and agents. It passes (`FIXED`, exit 0) only when the newest receipt (or the one you name) is intact, says `FIXED`, and its fix commit is exactly `HEAD`. If there is no receipt, or commits were added after it, the verdict is `UNVERIFIED` (exit 1). An edited receipt or a `NEEDS_REVIEW` receipt gives `NEEDS_REVIEW` (exit 2). Uncommitted changes add a warning, because only `HEAD` is checked.

```bash
# .git/hooks/pre-push
traceyard guard || exit 1
```

### `traceyard explain [evidence] [--failure <n>]`

Explains one failure from a recorded run. The default is the last failing run's first failure. You get the failure message with terminal codes and dependency stack frames removed, the `file:line` it points to, and 13 lines of source around that line at the run's commit, so an agent doesn't have to open the file.

### `traceyard inspect [evidence] [--offset <n>] [--limit <n>]`

Without an ID, `inspect` lists the 8 most recent runs and the 5 most recent receipts. With an evidence ID, it returns one slice of that run's full test log, 3,000 characters by default and at most 4,000. Follow `evidence.nextOffset` to read the next slice. With a receipt ID, it behaves like `receipt`.

### `traceyard receipt [id]`

Prints the newest receipt (or the one with that id) as Markdown. With `--json`, it returns the receipt body. Each receipt carries a SHA-256 digest of its contents. If the file was edited, `receipt` reports `intact: false` and the verdict `INCONCLUSIVE`.

Receipts have trust level `local`: they record what ran on this machine. Signed CI receipts come with the GitHub Action in Phase 3.

## Options

| Option            | Effect                                                                   |
| ----------------- | ------------------------------------------------------------------------ |
| `--case <name>`   | Pytest case to run, such as `TestCart::test_total`.                      |
| `--json`          | Print exactly one JSON object on stdout. Progress messages are silenced. |
| `--log`           | Include the last 4,000 characters of test output.                        |
| `--fetch`         | Let git fetch a commit that isn't in this clone.                         |
| `--install`       | `check` only: install missing dependencies in your working tree.         |
| `--fresh`         | Ignore the cached result for the same commit and test.                   |
| `--timeout <sec>` | Time limit for one test run. Default 180.                                |
| `--repo <dir>`    | Repository to use. Default: the current directory.                       |
| `--failure <n>`   | `explain` only: which failure to explain. Default 1.                     |
| `--offset <n>`    | `inspect` only: where the log slice starts. Default 0.                   |
| `--limit <n>`     | `inspect` only: slice length in characters, 200 to 4,000. Default 3,000. |

## Exit codes

| Code | Verdicts                                         | Meaning                                    |
| ---- | ------------------------------------------------ | ------------------------------------------ |
| 0    | `REPRODUCED`, `PASSED`, `FIXED`, `AVAILABLE`     | The command got the answer it was for.     |
| 1    | `FAILING`, `STILL_FAILING`, `UNVERIFIED`         | The test fails, or the fix isn't proven.   |
| 2    | `NOT_REPRODUCED`, `NEEDS_REVIEW`, `INCONCLUSIVE` | A person needs to look before trusting it. |
| 3    | `BLOCKED`                                        | The test could not run here.               |
| 64   | `ERROR`                                          | The command line was wrong.                |
| 70   |                                                  | A bug in Traceyard. Please report it.      |

## JSON output

With `--json`, every supported command prints exactly one JSON object on stdout; without it, commands print human-readable output. Progress is sent to stderr or suppressed as appropriate in JSON mode. The schema is `cliResultSchema` in [`shared/contracts/cli.ts`](../shared/contracts/cli.ts), and contract tests check every command against it. Fields are only added within `schemaVersion: 1`.

```bash
traceyard verify --json
```

```json
{
  "schemaVersion": 1,
  "command": "verify",
  "verdict": "FIXED",
  "exitCode": 0,
  "summary": "src/sum.test.js failed at c2b9e3e081cb and passes at 48c7902bf4c5, with no test files changed.",
  "next": "Open a pull request and attach the receipt.",
  "test": { "path": "src/sum.test.js", "case": null },
  "runs": [
    {
      "role": "baseline",
      "commit": "c2b9e3e081cb88e2a02f39960433d6b625abf56c",
      "workingTree": false,
      "status": "FAILED",
      "counts": { "passed": 1, "failed": 1, "skipped": 0 },
      "failures": [
        {
          "file": "src/sum.test.js",
          "name": "adds numbers",
          "message": "AssertionError: expected -1 to be 3 // Object.is equality\n    at src/sum.test.js:3:44"
        }
      ],
      "truncated": false,
      "durationMs": 737,
      "cached": true,
      "dependencies": "linked",
      "evidenceId": "ev_c2b9e3e081cb_3fd09b30eb84",
      "message": "1 passed, 1 failed, 0 skipped."
    },
    {
      "role": "candidate",
      "commit": "48c7902bf4c59e0320d0749bcf4553a9bd1c9327",
      "status": "SUCCEEDED",
      "...": "..."
    }
  ],
  "changedTests": [],
  "receipt": {
    "id": "rcpt_20261120084918982_d3a80a",
    "path": ".traceyard/receipts/rcpt_20261120084918982_d3a80a.json",
    "markdownPath": ".traceyard/receipts/rcpt_20261120084918982_d3a80a.md"
  },
  "warnings": []
}
```

- `next` is one sentence telling a person or agent what to do next.
- Output is bounded for agents: up to 5 failures, 600 characters each, with stack frames from `node_modules` removed. Raw output only appears with `--log`. A full result stays well under 1,500 tokens.
- Every run that executed has an `evidenceId`. The full log stays on disk; read it with `inspect <evidenceId>` in bounded slices. Terminal colours, progress bars, repeated lines and absolute paths are removed first.
- `repro`, `check` and `verify` also return `evidenceEnvelope`, the versioned evidence contract in [`shared/contracts/evidence.ts`](../shared/contracts/evidence.ts). It keeps the execution `state` (`COMPLETED`, `FAILED`, `BLOCKED`, `STALE`, ...) separate from the `claim` made about it (`FOCUSED_PASS`, `FAILED`, `INCONCLUSIVE`, ...), and records the exact revision (`commit`, or a `worktreeFingerprint` for `check`), input, policy and environment fingerprints, one entry per rule in `checks`, the `limitations`, and `next`. The claim is always derived from the state and checks, never set by hand.
  - CLI evidence is always `source: "LOCAL_PROVISIONAL"` and `scope: "FOCUSED"`: one selected test on this machine. `FOCUSED_PASS` is not proof that the whole suite passes or that a change is safe to merge.
  - `verify` reaches `FOCUSED_PASS` only for a `FIXED` verdict. Its checks are `reproduces-before`, `passes-after`, `distinct-commits`, `no-new-skips` and `test-inputs-unchanged`, so an `INCONCLUSIVE` claim names the rule that failed.
  - `check` fingerprints the working tree before and after the run. If a tracked file, or an untracked file that existed before, changes while the test runs, the state is `STALE`, the claim is `INCONCLUSIVE` and the verdict is `INCONCLUSIVE` (exit code 2). New untracked files, such as caches a test runner writes, don't count.
  - Receipts store the envelope inside their digest. `guard` treats a `FIXED` receipt whose envelope doesn't claim `FOCUSED_PASS` for the same fix commit as `NEEDS_REVIEW`. Receipts written before the envelope existed are still accepted.
- `dependencies` says how packages were made available:
  - `existing`: already installed.
  - `linked`: the commit has the same lockfile as your clone, so your `node_modules` was linked in.
  - `cached`: a previous run installed this exact lockfile, and that copy was reused.
  - `installed`: installed with lifecycle scripts off. For single-package projects the install goes into the dependency cache, so the next commit with the same lockfile reuses it.
  - `none`: the project needs no packages.

## Where things are stored

Everything lives in `.traceyard/` at the repository root. That folder contains its own `.gitignore`, so it never shows up in `git status`.

- `runs/`: one file per run, named by evidence ID. A commit's result never changes, so `repro` and `verify` reuse it; `--fresh` reruns. Working-tree runs from `check` are kept too (the newest 20), so `explain` and `inspect` can read them.
- `receipts/`: verification receipts.
- `last-repro.json`: the test and commit that `check` and `verify` default to.
- `last-evidence.json`: the run `explain` defaults to: the last failing one.

Installed dependencies are cached per user, outside the repository: `~/.cache/traceyard` on Linux, `~/Library/Caches/traceyard` on macOS and `%LOCALAPPDATA%\traceyard\Cache` on Windows. Set `TRACEYARD_CACHE_DIR` to move it. The 5 most recently used dependency sets are kept. Workspaces and `file:` or `link:` dependencies install inside the throwaway checkout instead, because they need the rest of the repository.

## Supported projects

- **Vitest and Jest** through a `test` (or `test:<folder>`) script in the nearest `package.json`. npm, pnpm, Yarn and Bun are detected from `packageManager` or the lockfile, including monorepos.
- **Pytest** files named `test_*.py` or `*_test.py`, with a `requirements.txt` or `requirements-test.txt` beside them. Traceyard uses `TRACEYARD_PYTHON`, then an active virtualenv, then `.venv` or `venv` in the repository, then `python3` on `PATH`. The interpreter needs pytest installed.

## Coding agents (MCP)

`traceyard mcp` serves six local tools over stdio to any MCP client. They run on your machine with no account. Hosted MCP is a different server with three tools (`investigate`, `inspect`, and `verify`) and requires OAuth plus project authorization; see [Connect a coding agent](MCP.md). The local tools return a bounded result envelope; they are not interchangeable with the hosted tool schemas.

| Tool        | Same as             | Use                                                                                     |
| ----------- | ------------------- | --------------------------------------------------------------------------------------- |
| `reproduce` | `traceyard repro`   | Rerun the failing test at the exact commit, or at the commit a GitHub Actions job used. |
| `check`     | `traceyard check`   | Run it against the working tree after each fix attempt.                                 |
| `verify`    | `traceyard verify`  | Prove the committed fix and write a receipt.                                            |
| `guard`     | `traceyard guard`   | Before claiming "fixed": `FIXED` only if HEAD has an intact FIXED receipt.              |
| `explain`   | `traceyard explain` | The first failure, the line it points to, and the source around it.                     |
| `inspect`   | `traceyard inspect` | Recent runs and receipts, a run's full log in slices, or a receipt's Markdown.          |

Each tool takes an optional `repo` (absolute path). It defaults to the directory the server started in, or to `--repo`.

**Claude Code**

```bash
claude mcp add traceyard -- npx -y traceyard mcp
```

**Cursor** (`.cursor/mcp.json`) and other clients that use `mcpServers`:

```json
{ "mcpServers": { "traceyard": { "command": "npx", "args": ["-y", "traceyard", "mcp"] } } }
```

**VS Code with GitHub Copilot** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "traceyard": { "type": "stdio", "command": "npx", "args": ["-y", "traceyard", "mcp"] }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.traceyard]
command = "npx"
args = ["-y", "traceyard", "mcp"]
```

For checkout development, replace `npx -y traceyard` with `node /path/to/traceyard/packages/cli/bin/traceyard.mjs` after running `npm ci` with Node.js 22.12.0 or newer.

### Token budget

Every tool response is under 1,500 tokens. The tests check this on each call, and `node scripts/bench-cli.mjs` records it in [`docs/benchmarks/cli-agent.json`](benchmarks/cli-agent.json). On the benchmark repository (10 Vitest cases, 7 failing), the full loop costs about 1,900 tokens across eight calls: reproduce, reproduce again, explain, two inspects, check, verify and guard. The largest single call is `verify` at about 470 tokens. A repeated `reproduce` at the same commit returns in about 70 ms from the cache.
