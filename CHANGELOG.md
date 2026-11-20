# Changelog

## Unreleased

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
