# CI test evidence

Traceyard can summarize the JUnit results from a test job, compare failures with the default branch, and show prior runs that had a different outcome for the same test. It works in the GitHub Actions run where your tests already execute. It uses the GitHub Actions token and artifact storage that come with the workflow.

## Add it to a test job

Configure your existing test runner to write JUnit XML to a fresh directory. Then run the Traceyard action even if the test step fails. Replace TRACEYARD_COMMIT with the full published commit of Traceyard you reviewed. In this Vitest example, the test job uses the tested checkout and Node 22.

```yaml
permissions:
  contents: read
  actions: read

steps:
  # Add after checkout, Node setup, and dependency installation.
  - name: Run tests
    id: tests
    run: |
      mkdir -p test-reports
      npx vitest run --reporter=default --reporter=junit --outputFile.junit=test-reports/unit.xml
  - name: Publish test evidence
    if: always() && !cancelled() && steps.tests.outcome != 'skipped'
    uses: fysaio/traceyard/runner/test-evidence@TRACEYARD_COMMIT
    with:
      reports: test-reports
      tested-sha: ${{ github.sha }}
      lane: linux-node22
      test-outcome: ${{ steps.tests.outcome }}
      token: ${{ github.token }}
```

Set tested-sha to the commit actually checked out if your workflow overrides the default checkout. Give each job and matrix combination a stable lane that identifies the OS, runtime, and test settings. Keep report filenames stable between runs. Use the test runner's normal exit status to gate the PR.

## Read the report

Open the workflow's **Summary**. It shows the tested commit and failing tests. It also links to the earlier runs used for comparison.

| Result             | Evidence                                                                             |
| ------------------ | ------------------------------------------------------------------------------------ |
| New failure        | The test failed here and its last observed result on the baseline branch was a pass. |
| Previously failing | The test failed here and its last observed baseline result was also a failure.       |
| Intermittent       | Directly observed pass and failure on the same tested commit and CI lane.            |
| No baseline        | The test failed and there was no comparable earlier baseline result.                 |

Baseline evidence comes from recent push runs of the same workflow on the repository's default branch. A prior attempt of the same GitHub Actions run can supply intermittent evidence. Repeated test identities inside one job still count toward the totals. Traceyard excludes those identities from history comparisons. Skipped tests provide no pass or fail observation.

The artifact keeps structured test names, source files where available, and outcomes for 14 days. Raw failure bodies, stdout, and stderr stay out of the artifact. Review any sensitive data your test names themselves include. If historical artifacts are missing, expired, or inaccessible, the report shows the available evidence and identifies failures whose baseline is unknown.

For a supported npm test you want to reproduce, open Traceyard Investigations and use the source file and exact tested commit from the summary. Use the original CI log for the full assertion and surrounding output.

## Rerun a Pytest failure

Traceyard can run a standard test_*.py or *_test.py file at a chosen commit. For a specific case, enter the part of its Pytest node ID after the file path, such as TestCheckout::test_total[wallet]. Select the connected repository in Investigations, review the commit and case, then choose **Run failing test**. Candidate verification carries the same case forward.

Put pytest and its test dependencies in requirements-test.txt or requirements.txt in the Python package. Traceyard creates a temporary virtual environment and requests binary wheels when installing. Test jobs use the Python on the configured runner. Tests that need project configuration should use the package's committed test fixtures and Pytest configuration. Focused runs clear addopts so it can't add test files or broaden the selected case.

Add traceyard-url to the CI evidence action for an **Open in Traceyard** link on a Pytest failure. Use your trusted HTTPS Traceyard origin. Generate JUnit with source paths so the action can derive the case selector.

```sh
python -m pytest -o junit_family=xunit1 --junitxml=test-reports/pytest.xml
```

The link prefills the repo, file, case and tested commit for review, then the user starts the run. Sign in and connect the intended repository before opening the link. If a report has no reliable case selector, enter the test file and case manually.

Pytest runs keep structured pass, fail, or skip evidence. Vitest supports interaction recording, isolated replay, and six-attempt flakiness checks.
