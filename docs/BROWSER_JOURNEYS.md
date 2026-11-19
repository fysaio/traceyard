# Browser replay

Record a user journey once, then use it to compare your app's previous and proposed builds on a pull request. Traceyard reuses the reviewed actions, assertions, and API responses. The report shows the exact commits, what passed or failed, and what changed on screen.

## Record a journey

Install Traceyard from a checkout of this repository with Node 22, then install Chromium once.

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

The recorder saves clicks and assertions. To record ordinary text inputs containing test data, add --inputs. Passwords and other sensitive input types are excluded. Add --capture once per approved API pathname. Only those JSON requests and responses are saved, with request bodies, response statuses and query strings used for matching. Use disposable test data and review the saved file before committing it. Session headers and cookies stay out of the file. The recorder stops when it cannot capture a required interaction.

## Add the pull request check

For an npm app with a lockfile and an npm run build script, pass the directory that contains the built index.html. Use the Traceyard checkout at a published commit so CI can fetch the same runner.

```sh
node "$TRACEYARD/agent/cli.mjs" setup-browser dist
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

Run from the app repository with your base and candidate builds already produced. The example compares two directories and writes screenshots and a diff to browser-evidence.

```sh
node "$TRACEYARD/agent/cli.mjs" compare-browser \
  .traceyard/browser/checkout.json "$BASE_SHA" "$HEAD_SHA" \
  --baseline-build /path/to/base/dist --candidate-build /path/to/head/dist \
  --evidence browser-evidence > browser-result.json
```

Browser interception is available locally for trusted builds. Use the generated GitHub workflow to replay untrusted build artifacts with network egress disabled. The runner supports static browser builds such as Vite or static exports, same-origin JSON APIs, and click, text, and URL assertions in Chromium. Keep production data, browser extensions, WebSockets, service workers, and live third-party endpoints out of recorded journeys.

If you already capture HTTP Archives, the browser-fixtures command can import a reviewed set of same-origin GET JSON responses into a journey. For repositories that commit static browser assets, compare-browser can read the assets from Git when both build directory options are omitted.
