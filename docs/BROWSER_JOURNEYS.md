# Compare a browser journey across commits

Use Traceyard to check whether a browser flow that failed on one commit passes on another. The same actions, assertions, and reviewed API fixtures run against both commits in fresh Chromium sessions.

## Set up a journey

1. In the Traceyard checkout, run `npm ci` and `npx playwright install chromium`.
2. In your app repository, commit a directory of static browser files at both revisions. Fetch both full commit SHAs.
3. Describe one flow using the app's `data-testid` attributes. List the same-origin GET responses you want to replay, with `null` as the placeholder for each.

```json
{
  "version": 1,
  "site": "site",
  "start": "/",
  "responses": { "/api/cart": null },
  "steps": [
    { "action": "click", "testId": "show-total" },
    { "action": "expectText", "testId": "total", "text": "$42.00" }
  ]
}
```

Save this as `journey-draft.json`. You can also add `fill` steps with a `testId` and `value`.

## Record once and compare

Run the flow on a local or test environment using a Playwright browser context with [HAR recording](https://playwright.dev/docs/api/class-browser#browser-new-context-option-record-har). Use embedded response bodies and close the context to flush the recording. Keep the HAR local, and review the extracted JSON before sharing it. The importer reads only the listed HTTP 200 JSON responses from the supplied origin. It excludes request headers and cookies. You can supply reviewed response bodies directly as well.

Run these commands from the app repository. Replace the example recording origin and use full SHAs for both commits.

```sh
TRACEYARD=/path/to/traceyard
node "$TRACEYARD/agent/cli.mjs" browser-fixtures journey-draft.json journey.har http://localhost:4173 > journey.json
node "$TRACEYARD/agent/cli.mjs" compare-browser journey.json "$BASE_SHA" "$HEAD_SHA" > browser-result.json
```

For pull requests, take the journey from a reviewed revision and use that copy for both runs. On GitHub Actions, the comparison writes a job summary automatically. Retain the JSON as a job artifact if reviewers need the assertion diagnostic or the list of missing requests.

| Result          | Meaning                                                     | Exit |
| --------------- | ----------------------------------------------------------- | ---- |
| `FIXED`         | The original assertion failed and now passes.               | 0    |
| `PASSED`        | Both revisions passed the journey.                          | 0    |
| `REGRESSION`    | The candidate failed an assertion that the baseline passed. | 1    |
| `STILL_FAILING` | Both revisions failed an assertion.                         | 1    |
| `INCONCLUSIVE`  | A required action or response was unavailable.              | 2    |

Setup errors exit with a diagnostic. A successful verdict applies to the supplied journey, and the report includes the exact commit and journey hashes.

## Where to use it

This version is for trusted test apps with committed static builds. It uses Playwright request interception, blocks service workers and WebSockets, and serves query-free same-origin GET JSON fixtures. It runs without a Traceyard account or a hosted runner. For untrusted commits, use an independently isolated runner with network egress disabled. Interactive recording, external services, writes, and visual diffs are outside this version.
