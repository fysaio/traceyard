# Live investigation acceptance — 18 November 2026

The operator deployed source `7cf9c401a5d1a1e5e3689003736068b05c3fbf66` to `https://traceyard.pilotsaviour229.workers.dev`, applied migrations through `0022_investigation_retention.sql` and updated the reviewed runner to `6bfde2973ff92f322b6d575e60a3212e2474bbcc`. The deployment log reports Worker version `cd35cf35-7288-44f4-a3f5-a65dae6acc1a`.

## Observed live

- Independent `GET /api/health` returned HTTP 200, `status: ok` and the exact deployed source SHA above.
- Protected-resource metadata returned HTTP 200 with the deployed `/mcp` URL and the declared investigation/recovery scopes.
- An unauthenticated MCP tool request returned HTTP 401 with its OAuth resource-metadata challenge.
- GitHub sign-in returned to a visibly authenticated workspace.
- Connecting the already-authorized public `fysaio/traceyard` repository created its project and completed bounded source discovery: 11 operations in 16 source files at `7cf9c40`.
- The investigation composer created a durable source-analysis finding. Its snapshot revision and coverage were visible, and the evidence reader returned the retained source operations. It explicitly stated that runtime behavior had not been verified.
- Connections displayed the MCP endpoint, repository connection and empty authorized-agent history.
- The application prepared [PR #17](https://github.com/fysaio/traceyard/pull/17), changing only `.github/workflows/traceyard.yml`. After explicit operator approval of its identity permission, the in-app setup merged the PR and enabled execution. The workflow pins the reviewed runner, uses `contents: read` and `id-token: write`, and limits execution to ten minutes.

## Live focused execution

The question `Run tests/unit/retry.test.ts and check whether retry handling passes.` launched [investigation `inv_cd70ded476d54dbba333b94a6835dd9c`](https://traceyard.pilotsaviour229.workers.dev/investigations/inv_cd70ded476d54dbba333b94a6835dd9c?project=prj_925b637c1ee146449c023727319f2ed1). The optional test selector was left empty. The runner inferred `tests/unit/retry.test.ts` and the existing `test:unit` script.

[GitHub run 44316066913](https://github.com/fysaio/traceyard/actions/runs/44316066913) completed successfully. The browser automatically changed from executing to evidence ready, displayed `7 passed, 0 failed across 1 test file(s)` and retained a structured report. Its executed revision was exactly `7cf9c401a5d1a1e5e3689003736068b05c3fbf66`, matching the investigation snapshot, although the workflow itself launched from the newer main revision. The report recorded exit code 0, Node v22.23.4, no omitted selected tests and no truncated failure evidence.

The selected test process reported 1,892 ms. This excludes GitHub queueing, runner checkout, dependency installation and evidence upload; it is not end-to-end latency or a billing/token measurement.

## Corrections found during this walkthrough

The project-switcher connection path opened the older repository page instead of Investigations. The evidence reader used original-artifact truncation to label the current page as its end, even when a next offset existed. Connections described a configured GitHub executor as connected before its repository workflow was enabled, and its setup-only dialog promised a run that the caller did not start. [PR #18](https://github.com/fysaio/traceyard/pull/18) addresses these observations and was merged after Linux validation, Windows tests/build, browser journeys and packaged-runner smoke tests passed. These corrections require a subsequent deployment to change the live UI.

## Still unverified live

A retained failing baseline/candidate verification and isolated replay remain unverified on the live deployment. A complete external MCP-client OAuth authorization and authenticated tool session are also still unverified. The remote browser cannot reach this workspace's loopback callback listener; that limitation does not establish a failure in a user's local coding client. No agent grant was created during this acceptance check. Public discovery, successful web sign-in and a passing web-launched test do not establish authenticated MCP operation. Existing CI covers these supported mechanisms with official-client, actual-process, browser and isolated-container fixtures; this report does not substitute those fixtures for live acceptance.
