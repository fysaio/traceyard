# TraceYard

Rerun a failing test at its original commit, then check the same test against your fix.

When CI goes red, the failing assertion, checkout SHA, and rerun often end up in different places. TraceYard keeps them together so you and your coding agent can review the same evidence before merging.

## 5-minute quickstart

The hosted quickstart uses the [TraceYard hosted instance](https://traceyard.pilotsaviour229.workers.dev/). You need a GitHub repository with a committed lockfile and a direct supported test script such as `"test": "vitest run"`. Hosted setup creates a workflow pull request; repository rules, maintainer review, and GitHub Actions queue time can add time. Self-hosted users should use their own origin and follow [Self-hosting](docs/SELF_HOSTING.md).

1. Open [TraceYard](https://traceyard.pilotsaviour229.workers.dev/), sign in with GitHub, and connect your repository. **See an example** is available without an account.
2. In **Repositories**, choose **Set up** and review the generated `.github/workflows/traceyard.yml`. Choose **Open pull request**, then review and merge that pull request on GitHub. TraceYard does not merge it for you.
3. Return to TraceYard after the workflow is merged and choose **Run checks**. Select the failing test file and the full failing commit SHA, or provide a GitHub Actions job link when TraceYard can identify the checkout.
4. Open the retained assertion and output. Under **Verify a repair**, enter the pushed candidate SHA and review the comparison, changed tests, and fixtures.

If the failure does not reproduce, **Check for flakiness** can run three fresh checkouts at each commit on GitHub Actions. Focused runs support Vitest, Jest, and [Pytest](docs/CI_TEST_EVIDENCE.md#rerun-a-pytest-failure). [Browser journey replay](docs/BROWSER_JOURNEYS.md) compares a user flow on two browser builds.

## Run it locally

Released CLI usage is available without installing globally:

```bash
npx traceyard@0.1.0 repro src/cart.test.ts --at <failing-sha>
npx traceyard@0.1.0 check
npx traceyard@0.1.0 verify
npx traceyard@0.1.0 guard
```

The CLI runs tests locally and does not require a TraceYard account or server. Dependency installation, optional Git fetching, and the initial `npx` package bootstrap can use the network. From a source checkout, after `npm ci` and with Node.js 22.12.0 or newer, use `node packages/cli/bin/traceyard.mjs ...` instead. See the [CLI guide](docs/CLI.md) for commands, JSON output, MCP, and exit codes.

## More

[CLI](docs/CLI.md) · [CI test evidence](docs/CI_TEST_EVIDENCE.md) · [Connect a coding agent](docs/MCP.md) · [Repository setup](docs/REPOSITORY_SETUP.md) · [Project experience](docs/PROJECT_EXPERIENCE.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Self-hosting](docs/SELF_HOSTING.md) · [Releases](docs/RELEASING.md) · [MIT license](LICENSE)
