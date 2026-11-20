# CI test evidence

TraceYard can summarize JUnit results from a test job, compare failures with the default branch, and show prior runs with a different outcome for the same test. It works in the GitHub Actions run where tests already execute. The current release is `0.1.0`; use Node.js 22.12.0 or newer locally.

## Add it to a test job

Configure the test runner to write JUnit XML to a fresh directory, then run the action even if the test step fails. Pin the action to a published, reviewed, fetchable 40-character TraceYard SHA. Do not use a local or unpushed TraceYard `HEAD`; GitHub must be able to fetch the revision.

```yaml
permissions:
  contents: read
  actions: read

steps:
  - name: Run tests
    id: tests
    run: |
      mkdir -p test-reports
      npx vitest run --reporter=default --reporter=junit --outputFile.junit=test-reports/unit.xml
  - name: Publish test evidence
    if: always() && !cancelled() && steps.tests.outcome != 'skipped'
    uses: fysaio/traceyard/runner/test-evidence@<40-character-reviewed-TraceYard-SHA>
    with:
      reports: test-reports
      tested-sha: ${{ github.sha }}
      lane: linux-node22
      test-outcome: ${{ steps.tests.outcome }}
      token: ${{ github.token }}
      # Optional; defaults to the repository default branch.
      baseline: main
      # Optional; must be an HTTPS TraceYard origin.
      traceyard-url: https://traceyard.example.com
```

Set `tested-sha` to the commit actually checked out if the workflow overrides the default checkout. Give each matrix combination a stable lane that identifies OS, runtime, and test settings. Keep one deterministic report filename per suite/lane: the report filename is part of normalized test identity, so renaming it or changing the lane can produce a new identity with **No baseline**. Use the test runner's normal exit status to gate the pull request. `baseline` defaults to `${{ github.event.repository.default_branch }}`.

## Read the report

Open the workflow's **Summary**. It shows the tested commit and failing tests and links to earlier runs used for comparison.

| Result             | Evidence                                                                       |
| ------------------ | ------------------------------------------------------------------------------ |
| New failure        | The test failed here and its last observed baseline result was a pass.         |
| Previously failing | The test failed here and its last observed baseline result was also a failure. |
| Intermittent       | A pass and failure were directly observed on the same commit and lane.         |
| No baseline        | The test failed and no comparable earlier baseline result exists.              |

Baseline evidence comes from recent push runs of the same workflow on the default branch. A prior attempt of the same run can supply intermittent evidence. Repeated test identities inside one job are excluded from history comparisons. Skipped tests provide no pass/fail observation.

The artifact keeps structured test names, source files where available, and outcomes for 14 days. Raw failure bodies, stdout, and stderr stay out of the artifact. Review sensitive data in test names. The optional **Open in TraceYard** link is primarily produced for Pytest findings when a reliable selector, file, and HTTPS `traceyard-url` are available.

For Vitest/Jest findings, open the hosted Investigations page, connect the matching repository, and enter the repository-relative test file and full tested SHA manually where the source path is available. The original CI log remains the source for the full assertion and surrounding output.

## Rerun a Pytest failure

TraceYard can run a standard `test_*.py` or `*_test.py` file at a chosen commit. For a specific case, enter the part of its Pytest node ID after the file path, such as `TestCheckout::test_total[wallet]`. Select the connected repository in Investigations, review the commit and case, then choose **Run failing test**. Candidate verification carries the same case forward.

Place `requirements-test.txt` (preferred) or `requirements.txt` directly beside the selected Python package/test scope. In a monorepo, verify that the file is in the package directory TraceYard indexes. It must include Pytest and every import needed by the selected test. TraceYard creates a temporary virtual environment and recognizes `test_*.py` and `*_test.py` names. Focused runs clear `addopts` so they cannot add test files or broaden the selected case.

Add `traceyard-url` inside the action step for an **Open in TraceYard** link, using a trusted HTTPS origin. Generate JUnit with source paths so the action can derive the case selector:

```sh
python -m pytest -o junit_family=xunit1 --junitxml=test-reports/pytest.xml
```

The link prefills the repository, file, case, and tested commit for review. Sign in and connect the intended repository before opening it; if no reliable selector is available, enter the file and case manually.

Pytest runs keep structured pass, fail, or skip evidence. Vitest supports interaction recording, isolated replay, and six-attempt flakiness checks.
