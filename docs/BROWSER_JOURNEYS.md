# Browser journey replay (static build comparison)

Record a user journey once, then use it to compare your app's previous and proposed builds on a pull request. Traceyard reuses the reviewed actions, assertions, and API responses. The report shows the exact commits, what passed or failed, and what changed on screen.

## Record a journey

Install TraceYard from a checkout of this repository with Node.js 22.12.0 or newer, then install Chromium once.

```sh
TRACEYARD=/path/to/traceyard
cd "$TRACEYARD"
npm ci
npx playwright install --with-deps chromium
```

Start a local preview of your built app with test data. In Vite, run npm run build and npm run preview. From the app repository, start the recorder and name each JSON API endpoint the journey uses.

```sh
node "$TRACEYARD/agent/cli.mjs" record-browser \
  http://localhost:4173/checkout .traceyard/browser/checkout.json \
  --capture /api/cart
```

Chromium opens with a recorder in the bottom right. Use the app as usual. Select **Assert text**, then click the text the app should show. Use **Assert URL** to check navigation. Select **Save journey** when you're done. For a repair, record the expected behavior on a working build.

The recorder saves clicks and assertions. To record ordinary text inputs containing test data, add `--inputs`. Passwords and other sensitive input types are excluded. `--capture` is an allowlist: add one flag for every same-origin JSON `fetch`/XHR pathname used anywhere in the journey, including endpoints reached after clicks. Query strings do not need separate flags because matching uses the pathname, but recorded query strings are matched. Only approved JSON requests and responses are saved. Use disposable test data and review the saved file before committing it. Session headers and cookies stay out of the file. The recorder stops when it cannot capture a required interaction.

## Add the pull request check

For an npm app with a lockfile and an npm run build script, pass the directory that contains the built index.html. Use a published, reviewed, fetchable 40-character TraceYard commit so CI can fetch the same runner; do not use an unpublished local `HEAD`.

```sh
node "$TRACEYARD/agent/cli.mjs" setup-browser dist --runner-revision <published-40-character-TraceYard-SHA>
```

Review and merge the generated workflow together with the journey. Later pull requests build both revisions independently and replay the journeys reviewed on the base branch. To add more coverage, record another JSON file in .traceyard/browser/ and merge it. The check supports up to 20 journeys per repository.

The replay container runs without network access. Unexpected API requests give an inconclusive result. A successful replay also requires every recorded response to be used. The job summary reports each verdict. Download traceyard-browser-evidence from the run for the JSON results, side-by-side screenshots, and a pixel diff. Pixel changes are evidence for review. Text and URL assertions determine the verdict.

| Verdict       | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| FIXED         | The same assertion failed on the base and passed on the candidate.    |
| PASSED        | Both revisions passed.                                                |
| REGRESSION    | An assertion passed on the base and failed on the candidate.          |
| STILL_FAILING | Both revisions failed an assertion.                                   |
| INCONCLUSIVE  | A required action, asset, or recorded response could not be replayed. |

## Run locally against existing builds

Run from the app repository with your base and candidate builds already produced. Chromium must be installed as shown above. The example compares two directories and writes the machine-readable verdict to `browser-result.json`, with screenshots and a diff in `browser-evidence`.

```sh
node "$TRACEYARD/agent/cli.mjs" compare-browser \
  .traceyard/browser/checkout.json "$BASE_SHA" "$HEAD_SHA" \
  --baseline-build /path/to/base/dist --candidate-build /path/to/head/dist \
  --evidence browser-evidence > browser-result.json
```

Browser interception is available locally for trusted builds. Use the generated GitHub workflow to replay untrusted build artifacts with network egress disabled. The runner supports static browser builds such as Vite or static exports, same-origin JSON APIs, and click, text, and URL assertions in Chromium. Keep production data, browser extensions, WebSockets, service workers, and live third-party endpoints out of recorded journeys.

The local comparator exits `0` for a non-regression result, `1` when a candidate assertion fails, and `2` when the result is `INCONCLUSIVE`. A nonzero comparison verdict is not necessarily a tool error; inspect `browser-result.json` and the evidence directory.

If you already capture HTTP Archives, the browser-fixtures command can import a reviewed set of same-origin GET JSON responses into a journey. For repositories that commit static browser assets, compare-browser can read the assets from Git when both build directory options are omitted.
