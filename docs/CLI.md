# Traceyard CLI

Prove a failing test is fixed, on your own machine. No account, no server, no network unless you ask for it.

```bash
traceyard repro src/cart.test.ts --at 3f2c9e1   # fails at the commit CI tested
traceyard check                                 # run it against your edits, as often as you like
git commit -am "Fix cart rounding"
traceyard verify                                # failed before, passes now, test untouched
traceyard receipt                               # Markdown you can paste into the PR
```

Until the npm package ships (#49), run it from a Traceyard checkout with `node packages/cli/bin/traceyard.mjs`. Node 22.12 or later.

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
3. No tests, fixtures, snapshots, mocks or test runner config changed between the two commits.

Each verify writes a receipt to `.traceyard/receipts/` as JSON and Markdown.

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

## Exit codes

| Code | Verdicts                                         | Meaning                                    |
| ---- | ------------------------------------------------ | ------------------------------------------ |
| 0    | `REPRODUCED`, `PASSED`, `FIXED`                  | The command got the answer it was for.     |
| 1    | `FAILING`, `STILL_FAILING`                       | The test fails on your change.             |
| 2    | `NOT_REPRODUCED`, `NEEDS_REVIEW`, `INCONCLUSIVE` | A person needs to look before trusting it. |
| 3    | `BLOCKED`                                        | The test could not run here.               |
| 64   | `ERROR`                                          | The command line was wrong.                |
| 70   |                                                  | A bug in Traceyard. Please report it.      |

## JSON output

Every command prints one object. The schema is `cliResultSchema` in [`shared/contracts/cli.ts`](../shared/contracts/cli.ts), and contract tests check every command against it. Fields are only added within `schemaVersion: 1`.

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
- `dependencies` says how packages were made available: `existing` (already installed), `linked` (the commit has the same lockfile as your clone, so your `node_modules` was linked in), `installed` (installed in the throwaway checkout with lifecycle scripts off), or `none`.

## Where things are stored

Everything lives in `.traceyard/` at the repository root. That folder contains its own `.gitignore`, so it never shows up in `git status`.

- `runs/`: cached results, one per commit and test. A commit's result never changes, so `repro` and `verify` reuse it. `--fresh` reruns.
- `receipts/`: verification receipts.
- `last-repro.json`: the test and commit that `check` and `verify` default to.

## Supported projects

- **Vitest and Jest** through a `test` (or `test:<folder>`) script in the nearest `package.json`. npm, pnpm, Yarn and Bun are detected from `packageManager` or the lockfile, including monorepos.
- **Pytest** files named `test_*.py` or `*_test.py`, with a `requirements.txt` or `requirements-test.txt` beside them. Traceyard uses `TRACEYARD_PYTHON`, then an active virtualenv, then `.venv` or `venv` in the repository, then `python3` on `PATH`. The interpreter needs pytest installed.
