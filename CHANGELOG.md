# Changelog

## Unreleased

- A hosted investigation result that arrives after its attempt was closed, or after a retry replaced it, is now rejected. Before, the result from a stalled first attempt could replace the investigation's status and finding while the retry was still running. [Managed execution](docs/MANAGED_EXECUTION.md#state-boundaries)
- `traceyard verify` and hosted verification no longer accept a pass that comes from changing how the test runs. Both now use one set of test-input rules, which adds setup files and more runner config names. Each JavaScript run also records a digest of its test script, `jest` key and named config file. Before, a fix commit could point the test script at a lenient config and still come back `FIXED`. Older cached local runs are rerun once to record the digest. [Execution trust](docs/EXECUTION_TRUST.md#test-inputs)
- Managed checks run repository code as a separate, unprivileged user. The agent starts as root and runs every install, build, test and application process as `node`, so repository code cannot read the agent's environment or credential. If the switch cannot be confirmed, no repository command runs. [Execution trust](docs/EXECUTION_TRUST.md)
- Repository tests and applications no longer receive the Traceyard reporting credential. Before, it was passed to them so they could export traces. They now export through a loopback relay in the runner, which only forwards OTLP trace batches. Hosted runs no longer read the repository's `.env.traceyard`, and local runs read only `TRACEYARD_ORIGIN` and `TRACEYARD_KEY` from it. Remaining gaps are listed in [execution trust](docs/EXECUTION_TRUST.md).
- `traceyard repro`, `check` and `verify` return a versioned `evidenceEnvelope` that keeps run state, claim, scope, trust, revision and limitations explicit. Local evidence is always a focused, provisional claim about one test. The MCP tools return a compact `claim` that is never dropped when a response is shortened. Receipts include the envelope, and `guard` rejects a receipt whose envelope disagrees with its verdict. [CLI guide](docs/CLI.md#json-output)
- Hosted verifications return the same `evidence` envelope, marked `HOSTED_UNATTESTED` and bound to the exact candidate commit. A focused pass is claimed only when the verdict is `PASSED`, and the MCP `inspect` response keeps the claim when shortened. Hosted results are not attested until reporting moves to a trusted supervisor. [MCP guide](docs/MCP.md)
- `traceyard check` reports `INCONCLUSIVE` (state `STALE`) when tracked files change while the test runs, instead of a pass or failure for a tree that no longer exists.

## 0.1.0

- Added `traceyard mcp`, a local MCP server for Claude Code, Cursor, Codex and Copilot. Its tools are `reproduce`, `check`, `verify`, `guard`, `explain` and `inspect`, and they return the same bounded envelope as the hosted server. [Setup](docs/CLI.md#coding-agents-mcp)
- Added `traceyard guard`, a merge gate that passes only when HEAD has an intact FIXED receipt. Also added `traceyard explain`, which shows the failing line with its source, and `traceyard inspect`, which reads a full log in slices by evidence ID.
- Agent output is cheaper. Every response stays under 1,500 tokens, and terminal codes, progress bars and repeated lines are removed. Logs are returned only when asked for. Dependency installs are cached by lockfile, so the next commit with the same lockfile doesn't reinstall. [Benchmark](docs/benchmarks/cli-agent.json)
- Fixed plain-text output crashing when a run had failures.

- Added the `traceyard` command-line tool: `repro` reruns a failing test at the exact commit (or the commit a GitHub Actions job tested), `check` runs it against your edits, `verify` confirms it failed before and passes now without test changes, and `receipt` prints the result for a pull request. It returns stable JSON and documented exit codes, and needs no account. [CLI guide](docs/CLI.md)
- Run focused Vitest and Jest tests from the selected npm package, including nested workspaces and named scripts such as `test:unit`.
- Cache npm downloads for GitHub checks using the application and runner lockfiles. Each check still installs dependencies and runs the selected tests.

## 2026-11-19

- Shortened the README to the first investigation and added a contributor guide.
- Moved development notes and release evidence into their pull requests. Removed the unrelated Somni prototype and old screenshots.
- Added a landing page with an interactive failed-test example. Investigation results show the finding, test output and repair action together. Phone navigation keeps search and project selection available. [PR #28](https://github.com/fysaio/traceyard/pull/28)
- Simplified investigation reads and removed unused backend paths. [PR #27](https://github.com/fysaio/traceyard/pull/27)

### Hosted verification

An authorized MCP client requested a fresh verification of the saved failure in `tests/unit/repair-acceptance.test.ts`. The controlled baseline at `bf0364f` failed its checksum assertion. The same test passed at `3111676` after a change to `shared/repair-target.ts`. Traceyard reported `PASSED` with zero changed test files (`ver_11fc36d6c884461badc1c7e8912e1020`). [Failing run](https://github.com/fysaio/traceyard/actions/runs/44373451602) · [Passing rerun](https://github.com/fysaio/traceyard/actions/runs/44425840177) · [Source diff](https://github.com/fysaio/traceyard/compare/bf0364f9bdda461345d932716dbcc5db6b364496...31116766d45d49fcd4e0364ce4a67b753f22ad23)

## 2026-11-18

- Agent sign-in can happen before you choose a repository. Project access is granted separately. [PR #26](https://github.com/fysaio/traceyard/pull/26)
- Added focused Vitest runs for connected GitHub repositories and repair verification against a pushed commit. The first hosted run executed `tests/unit/retry.test.ts` at the selected revision. [GitHub Actions run](https://github.com/fysaio/traceyard/actions/runs/44316066913) · [Repair verification](https://github.com/fysaio/traceyard/pull/10)
- Fixed browser consent and kept the authenticated MCP event stream open for clients that require it. [Consent fix](https://github.com/fysaio/traceyard/pull/20) · [Stream fix](https://github.com/fysaio/traceyard/pull/22)
- Verified production workflow retry and checkpoint recovery with a sample document. [PR #19](https://github.com/fysaio/traceyard/pull/19)
