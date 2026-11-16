# Connected project experience

This revision implements a connected, repository-backed application journey rather than another standalone UI prototype. It extends the automatic project setup in PR #4. Production deployment and live GitHub App acceptance remain separate release checks.

## Screens and actions

- `/projects`: owned applications, repository/setup/check state, actual recorded-run counts, search, connect repository and local project creation.
- `/projects/:id`: background discovery/setup progress, source and observed operations, search/failure filter, current check, recent run history, test settings and connection actions. Connecting source here explicitly attaches it to the existing project so earlier traces are retained. Connecting from Projects creates/reuses the repository project.
- `/projects/:id/operations/:key`: stable source identity, exact-commit source link, direct static calls, actual linked run history, saved HTTP test fixtures and test launch. Static calls are not displayed as a verified ordered execution graph. An unresolvable runtime operation remains visible rather than being assigned a speculative source match.
- `/projects/:id/runs/:trace`: real parent/child timeline, per-step timing/status/attributes, captured input/output only when present, error evidence, saved request assertions and optional redacted response preview, copy ID, JSON export and return navigation.
- `/projects/:id/checks/:check`: latest actual event for each runner phase, GitHub logs, explicit cancellation request for a running GitHub job, and the recorded application runs from that job. Cancellation remains requested until GitHub reports the stopped state.
- `/projects/:id/compare`: choose two recorded runs in a history and compare statuses, timings and available request-test assertions. This is descriptive comparison, not a certified regression verdict with guaranteed identical environments.

The optional Traceyard builder, Gateway and other existing tools remain accessible. Native SVG icons were not introduced: new controls use the existing Font Awesome font pack. Soft card/control radii, custom rounded checkboxes, surface focus states, keyboard labels, reduced-motion styles, touch-size inputs and narrow-screen layouts are in `src/styles/project-experience.css`.

## Operation identity and evidence

Source operation keys hash the repository-relative file and operation name, so adding lines above a handler does not change its key. A source operation links to runtime evidence only through an explicit operation key, a unique method/route combination, or a corresponding source file/name. Name-only matching is deliberately insufficient. Unlinked runtime groups include the service name in their identity. This is not full inter-file call graph inference.

Catalogs cover up to the latest 500 application traces and 100 bounded source discoveries. History renders in batches. The project list counts persisted traces independently. Old Traceyard-managed executions continue to use their existing execution pages; the new application inspector handles externally recorded application traces. The source scanner and automatic runtime support remain bounded as documented in REPOSITORY_SETUP.md.

## Saved request execution

Migration 0011 adds runner configuration, owned request fixtures, immutable requested-test snapshots and retained request results. Setup requires a repository-relative application directory, an existing npm startup script and an unused local port. No arbitrary remote test URL or arbitrary shell command is accepted by the settings forms.

A saved test includes an HTTP method, local path, optional JSON body, expected status and an optional JSON field/value assertion. Response preview capture is off by default. Known credential fields/tokens are redacted and previews/responses are bounded. Fixtures should contain test data; application keys/database credentials are not copied into the dashboard.

GitHub launch stores the selected configuration/case before dispatching a request ID to the installed workflow. The runner retrieves the snapshot through project-scoped GitHub OIDC, and the request is bound to that signed run. Local execution can select a case with:

```bash
node /path/to/traceyard/agent/cli.mjs run . --case YOUR_CASE_ID
```

The local key's project supplies its settings. Source paths stay relative to the original repository even when the configured application lives in a subdirectory. Realpath containment prevents a configured symlink from escaping the selected checkout.

The runner installs locked dependencies and builds if configured, then either runs the existing npm test suite or launches the configured application for the selected request test. It waits up to 30 seconds for the local port, rejects an already occupied port, uses a 15-second bounded request and never follows redirects. The entire request-check process is bounded to 180 seconds. It records a real measured trace and assertion verdict, then stops the application process group. Test-only Node instrumentation also records supported server activity. This does not automatically provision databases, configure external services, generate inputs, discover every business workflow, or record remote Deno/Python/browser execution.

Existing installations need a reviewed runner version that accepts `run_request` and retrieves test settings. Test settings includes **Prepare runner upgrade PR**, which proposes the current pinned workflow in a separate branch; the default branch is not edited or merged automatically. The deploying operator must pin TRACEYARD_RUNNER_REF to a reviewed commit containing this agent and lockfile.

The runner still ships from a checkout, not a published/browser-authenticated package. Existing local `scan` and `connect` commands remain supported. Per-project fixtures are not a permanent application server, and this change does not implement visual rewriting of application business logic or automatically generated fixes.

## Verification

Automated tests exercise project isolation, conservative source matching, complete application-run reads, local request-target/path validation, saved configuration, immutable requested settings, preview opt-in, and scoped fixture deletion. A spawned real Node HTTP application verifies passing/failing assertions, actual measured trace export, credential redaction and process cleanup. Existing npm-suite checks continue to run.

The managed browser preview was blocked by automatic approval review because it may disclose source/build artifacts to sparrow.cloudflare.com. No browser screenshots, visual sign-off or physical-phone verification is claimed for this revision. The reviewer must approve that preview destination or use their own local browser before treating the new layout as visually accepted. Existing public chatgpt.site remains a separate prototype.
