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
- The application prepared [PR #17](https://github.com/fysaio/traceyard/pull/17), changing only `.github/workflows/traceyard.yml`. The preview pins the reviewed runner, uses `contents: read` and `id-token: write`, and limits execution to ten minutes. It remained awaiting approval; execution was not enabled during this check.

## Corrections found during this walkthrough

The project-switcher connection path opened the older repository page instead of Investigations. The evidence reader used original-artifact truncation to label the current page as its end, even when a next offset existed. Connections described a configured GitHub executor as connected before its repository workflow was enabled, and its setup-only dialog promised a run that the caller did not start. The follow-up UI changes address these observations; they require a subsequent deployment to change the live UI.

## Still unverified live

A focused GitHub execution, retained failing baseline/candidate verification and isolated replay remain behind the repository execution setup. A complete external MCP-client OAuth authorization and authenticated tool session are also still unverified. Public discovery and a successful web sign-in do not establish those outcomes. Existing CI covers these supported mechanisms with official-client, actual-process, browser and isolated-container fixtures; this report does not substitute those fixtures for a live repository run.
