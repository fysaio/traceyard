# Traceyard

Rerun a failing Vitest test at its original commit, then check the same test file against your fix.

When CI goes red, the failing assertion, checkout SHA, and rerun often end up in different places. Traceyard keeps them together so you and your coding agent can review the same evidence before merging.

![Traceyard and its example of a failed test with a candidate rerun](docs/images/traceyard.png)

## 5-minute quickstart

Start with the path of a failing Vitest test, the commit that failed, and a pushed candidate fix. You need a GitHub-hosted npm repository with a lockfile and a direct npm script such as `"test": "vitest run"`. Hosted setup requires a pull request merged into the default branch. Merge requirements and CI queues can add time.

1. Open [Traceyard](https://traceyard.pilotsaviour229.workers.dev/), sign in with GitHub, and connect your repository. **See an example** is available without an account.
2. If tests need setup or an update, choose **Review workflow change** in **Investigations**. Review `.github/workflows/traceyard.yml`, create the setup PR, and merge it on GitHub. If repository rules require a maintainer, ask them to review and merge it. While blocked, run the same test locally at both commits and keep the output.
3. In **Investigations**, enter the failing test file and the full failing commit SHA. You can paste a GitHub Actions job link and choose **Use tested commit**. Review the commit before choosing **Run failing test**. If the checkout is ambiguous, enter the SHA from the job log.
4. Open the failing assertion, executed commit, and retained output. Under **Verify a repair**, enter the pushed candidate SHA. Compare both runs and review any changed tests or fixtures. The verdict covers the recorded test file and conditions.

If the failure does not reproduce, **Check for flakiness** can run three fresh checkouts at each commit on GitHub Actions. Allow up to about 10 extra minutes on the runner plus queue time. The result shows each attempt.

Focused Jest runs are also available for supported npm packages. The flakiness check uses Vitest.

[Record a browser journey](docs/BROWSER_JOURNEYS.md) to compare a user flow on two browser builds and review the result on a pull request.

## More

[CI test evidence](docs/CI_TEST_EVIDENCE.md) · [Connect a coding agent](docs/MCP.md) · [Repository setup](docs/REPOSITORY_SETUP.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Self-hosting](docs/PRODUCTION_RELEASE.md) · [MIT license](LICENSE)
