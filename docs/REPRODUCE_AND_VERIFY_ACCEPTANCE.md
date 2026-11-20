# Reproduce and verify acceptance protocol

Use a fresh tester who has no TraceYard source access. Provide the public documentation, deployed app and MCP endpoint, and a disposable npm/Vitest fixture repository with a known failing baseline and pushed candidate commit. Record the expected manual result before handing the task to the tester.

## Test materials

Prepare:

- The deployed HTTPS TraceYard origin and the hosted MCP URL.
- A GitHub fork the tester can authorize, with a committed lockfile and a direct test script such as `vitest run`.
- A baseline SHA whose selected test fails and a candidate SHA whose same test passes without changing the test/fixture, unless the scenario intentionally tests the changed-test verdict.
- The exact repository-relative test path and, when needed, test case selector.
- An account with permission to install/authorize the TraceYard GitHub App and merge the setup workflow, or a prepared environment where that workflow is already merged.

## Two runs

### Prepared-environment usability run

The fork, baseline/candidate SHAs, account authorization, repository connection, and setup workflow are prepared before timing starts. Start the clock when the tester opens the quickstart page. Stop at the first focused result showing the correct assertion, full executed SHA, and retained output. Record TraceYard product time separately from GitHub queue and dependency-install time.

### First-time setup run

Start the clock when the tester opens the public quickstart with no repository connection. Include sign-in, repository authorization, discovery, setup-PR creation, GitHub review/merge wait, workflow queue, dependency installation, focused execution, and evidence review. Record each external maintainer or queue wait separately. If setup cannot be authorized or merged, stop the product timer and record `BLOCKED`, not “gave up.”

For the “first useful result” criterion, the target is under 10 minutes of product time. End an unblocked attempt at 15 minutes. Do not treat external queue or maintainer wait as product interaction time, but report it in the results.

## Exact user actions

1. Open the deployed origin and sign in with GitHub.
2. Connect the fixture repository and wait for discovery.
3. If this is not a prepared environment, choose **Set up**, review `.github/workflows/traceyard.yml`, choose **Open pull request**, and merge the PR on GitHub.
4. Return to TraceYard, choose **Run checks**, select the repository-relative test file, and enter the exact baseline SHA.
5. Confirm the assertion, executed SHA, and retained output. Record the investigation/evidence URL or IDs.
6. Enter the pushed candidate SHA under **Verify a repair** and record the verdict, changed test/fixture paths, and next action.
7. Repeat the same baseline/candidate operation through hosted MCP: authenticate, call `inspect(section: "capabilities")`, approve/select the project if required, call `investigate`, then `verify` with the investigation ID and full candidate SHA.

## Criteria

| Criterion           | Pass                                                                                                                                  | Fail                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| First useful result | Correct assertion, full SHA, and retained output within the target product time.                                                      | Evidence is missing/wrong, or an unblocked attempt exceeds the limit.               |
| Less work           | Same evidence and candidate verdict as the manual workflow with less elapsed product time or fewer manual actions.                    | Saving comes from weaker evidence, a wrong result, or omitted manual work.          |
| Trusted result      | Browser and MCP identify the same baseline/candidate evidence and verification state.                                                 | Evidence belongs to a different commit/test or surfaces disagree.                   |
| Honest limits       | The app distinguishes failures, unsupported repositories, and incomplete execution and limits claims to the recorded test/conditions. | It claims a cause or completed test without evidence, or silently changes revision. |
| Reason to return    | Tester names a concrete next task where retained evidence or agent handoff saves work.                                                | Tester identifies no future use.                                                    |

## Expected verification states

| Machine/API state          | User-facing mapping      | Required observation                                                                                          |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `CONFIRMED`                | Confirmed                | Baseline failed, same test passed at candidate, and no test/fixture changes.                                  |
| `PASSED_WITH_TEST_CHANGES` | Passed with test changes | Candidate passed but test or fixture paths changed; list those paths.                                         |
| `STILL_FAILING`            | Still failing            | Candidate assertion failed; show the observed result.                                                         |
| `INCONCLUSIVE`             | Inconclusive             | Flaky or incomplete comparison evidence; explain what is missing.                                             |
| `BLOCKED`                  | Usually Inconclusive     | Execution could not start or complete. Record the blocked stage and reason separately from the verdict label. |

## Results template

```text
Tester:
TraceYard origin / MCP URL:
Fixture repository and fork:
Baseline SHA / candidate SHA:
Test path and case:
Prepared or first-time protocol:
Start/end timestamps:
Product time:
GitHub queue/maintainer wait:
Dependency-install time:
Browser actions and URLs:
MCP actions and IDs:
Manual-workflow comparison:
Machine/API state:
User-facing label:
Blocking reason (if any):
Final observations and deviations:
```
