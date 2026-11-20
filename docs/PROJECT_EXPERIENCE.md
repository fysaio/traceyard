# Connected repository experience

TraceYard provides a connected, repository-backed experience. The current user-facing resource is a **repository**; **project** remains an API/resource term and a legacy compatibility name for older `/projects` links.

## Current screens and routes

- `/repositories`: connected repositories, discovery/check state, search, and the **Connect repository** action. The list shows repository status and the latest check; it does not promise recorded-run counts.
- `/repositories/:id`: repository details, discovery status, source operations, recent checks, **Test settings**, and setup/investigation actions.
- `/repositories/:id/checks/:checkId`: the current check and its available stage/evidence details.
- Setup, settings, and investigation pages are reached from the repository UI. The exact labels are **Set up**, **Review setup**, **Open pull request**, and **Run checks**.

The old `/projects` and `/projects/:id` routes redirect for compatibility. Operation-detail, application-run-detail, and compare URLs described by older drafts are not shipped frontend screens; related catalog and run-history capabilities are backend/API surfaces and should not be treated as navigable UI.

## Source-first exploration

Source discovery can show candidate operations before application execution. Readable nested calls expose same-file helper relationships, source lines, conditional/error/loop/callback context, and unresolved boundaries. This is source evidence, not a fabricated run timeline. The scanner is bounded to 12 calls and three local-helper levels; cross-file imports and complete business-workflow reconstruction remain incomplete.

## Repository setup flow

1. Connect the repository and wait for source discovery.
2. Open **Set up** or **Review setup**, inspect the generated `.github/workflows/traceyard.yml`, and choose **Open pull request**.
3. Review and merge the pull request on GitHub under the repository's rules. TraceYard does not merge it itself.
4. Return to TraceYard and choose **Run checks**.

For a request-test setup, open **Test settings**, choose the repository-relative application directory, startup script, and port, then save a fixture for a discovered HTTP operation before running it. If an operation-specific fixture control is unavailable in the deployed instance, use the documented API/runner path rather than assuming an unshipped screen exists.

## Saved request execution

A saved test includes an HTTP method, local path, optional JSON body, expected status, and an optional JSON field/value assertion. Response previews are off by default; known credentials are redacted and previews are bounded. Use test data, not production credentials.

Managed launch freezes the selected configuration, case, and commit before queueing an isolated runner. Repeating the same request ID returns its original check. Local execution can select a case with:

```bash
node /path/to/traceyard/agent/cli.mjs run . --case YOUR_CASE_ID
```

The runner installs locked dependencies, starts the configured application, waits up to 30 seconds for the port, uses a 15-second request timeout, does not follow redirects, and bounds the request-check process to 180 seconds. It does not provision databases or external services automatically.

Catalog APIs are bounded to up to 500 application traces and 100 source discoveries. Those are backend limits, not a claim that the current frontend renders paginated run history.

## CLI status

The released npm CLI is available as `npx traceyard@0.1.0`. From a source checkout, after `npm ci` and with Node.js 22.12.0 or newer, use `node packages/cli/bin/traceyard.mjs ...` as the development fallback. See [repository setup](REPOSITORY_SETUP.md) and the [CLI guide](CLI.md) for the complete local and hosted paths.
