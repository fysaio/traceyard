# Investigation release and acceptance

## Delivered developer path

Connect a GitHub repository, ask about the failure and run a focused existing Vitest test. Read the concise finding, expand only the needed evidence, repair through the existing coding agent and verify an immutable candidate commit. The MCP endpoint and web app use the same project-owned records. Source analysis remains available without runtime instrumentation. Enabling GitHub execution requires one reviewed workflow; the app prepares that change. Agent authorization uses browser OAuth rather than copied keys. Production tracing remains optional and separate.

## Acceptance gates

| Gate                          | What it establishes                                                                                                                           | What it does not establish                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Migrated D1 integration suite | Ownership, immutable snapshots/results/recordings, deduplication, cancellation, verification and bounded evidence                             | Availability of a customer's application environment                           |
| Official MCP SDK tests        | Automatic OAuth discovery/registration/PKCE, protocol tools, scoped calls, reconnect and revocation against the Worker                        | Compatibility with every agent product or deployed account                     |
| Actual fixture processes      | Focused failing assertion, repaired result and related regression selection                                                                   | Production application correctness                                             |
| Docker replay CI              | One actual fetch capture, network-disabled replay, failed reproducer, passing repair, divergence refusal and host-write isolation             | Arbitrary execution, streaming/database/tool replay or production continuation |
| Browser CI                    | Connected question/composer flow, responsive widths, evidence drilldown, MCP connections and actual local-D1 record persistence across reload | A live GitHub login or a paid provider                                         |
| Packaged runner CI            | The built Node 22 image executes actual success/test-failure/install-failure processes without external networking                            | Docker-in-Docker availability in managed deployments                           |
| Reproducible benchmark        | Measured focused/full evidence bytes and local process duration                                                                               | Agent tokens, hosted cold start, provider billing or a general savings rate    |

Run `npm test`, `npm run build`, `npm run build:managed`, `npm run lint`, and `npx tsc -p tsconfig.test.json --pretty false`. CI additionally runs `node scripts/verify-isolated-replay.mjs`, the built runner image and `npx playwright test --config playwright.investigations.config.ts`.

## Windows compatibility

Node ESM loader registration uses a `file:` URL converted from the resolved instrumentation path. A bare Windows drive-letter path is not an ESM specifier. CI runs the full unit/Worker suite and production build on Windows with Node 22.19.0, in addition to the Linux and container gates.

## Local operator settings and tests

Integration tests use `tests/wrangler.jsonc` with local-only resources and fixed fixture settings. They do not load credentials or runner pins from the operator's root `.dev.vars` or `.env`. Both Windows and Linux release CI create synthetic operator files before running the complete suite and production build, so a clean CI account cannot hide this environment difference. Keep the real local settings in place when running the release command.

## Cost accounting

`npm run bench:investigation -- --output /tmp/investigation-fixture.json` reruns a controlled 12-file Vitest fixture. The retained local result is [investigation-fixture.json](benchmarks/investigation-fixture.json). That run reduced evidence from 7,638 to 1,484 bytes, executed one selected file instead of twelve, then verified the repaired assertion. No paid model or provider was called in that fixture. The measured duration excludes GitHub checkout and dependency installation. Values vary with environment; evidence bytes are not a token estimate.

A packaged replay-bootstrap acceptance also verifies that dependency installation does not execute application lifecycle hooks and that missing Docker blocks test execution.

The runner has its own pinned lockfile and installs 193 packages. It does not install the application web UI or MCP server dependency tree. `runner/prepare.mjs` copies the reviewed agent into that dependency package. Both GitHub bootstrap and the managed runner image use this package. Source indexing and summaries use deterministic code. Test execution still consumes the executor's resources; live application tests can incur provider charges. Eligible replay avoids a live fallback, but Docker image preparation has an initial download and storage cost.

## Runtime limits and lifecycle

Focused execution currently supports npm projects with an unambiguous direct Vitest script. Existing Node and other runner commands remain available through ordinary repository checks. Recording is optional, limited to supported JSON global fetch interactions, and refuses incomplete or divergent replay. Managed container deployments do not automatically have a nested Docker daemon; they block isolated replay when that capability is absent. GitHub-hosted Linux runners supply the supported Docker executor. Replay dependency installation disables lifecycle scripts and receives no application credentials. Projects that require install-time native builds or private registry credentials can block; ordinary execution remains separate.

A protocol header prevents old runners from treating focused plans as ordinary full-suite requests. Review execution setup in Connections to update a repository workflow. Investigation cancellation closes the durable record and requests the same external cancellation used by repository checks. An unconfirmed external cancellation remains explicitly uncertain. Hosted work that produces no complete report within fifteen minutes becomes blocked without automatic duplicate execution. Thirty-day inactive investigations and their artifacts expire; latest complete source indexes are preserved. OAuth transient records also expire.

Reviewed bootstrap: [`6bfde2973ff92f322b6d575e60a3212e2474bbcc`](https://github.com/fysaio/traceyard/commit/6bfde2973ff92f322b6d575e60a3212e2474bbcc). The shared runner version pins hosted setup and the optional local command to this immutable source.

## Production rollout

Code merge and production deployment are separate. On 18 November the operator deployed `7cf9c401a5d1a1e5e3689003736068b05c3fbf66`, migrations through 0022 and the reviewed runner from the existing authenticated Cloudflare environment. A live GitHub sign-in, repository connection and inferred focused test succeeded; see [the acceptance record](LIVE_INVESTIGATION_ACCEPTANCE_2026-11-18.md). Live external MCP authorization, repair verification and replay remain open. This workspace itself still has no authenticated Cloudflare session. No new GitHub/provider secrets should be pasted into chat.

From a clean `main` checkout after the PR checks pass:

```sh
git pull --ff-only
npm ci
npx wrangler login
npm run deploy:investigations -- --origin https://traceyard.pilotsaviour229.workers.dev
```

The release command runs tests/build, applies migrations through `0022_investigation_retention.sql`, updates the existing `TRACEYARD_RUNNER_REF` secret to the reviewed bootstrap revision, deploys the standard Worker with its exact source SHA, and checks public health, MCP resource metadata and the unauthorized challenge. It reuses existing server-side GitHub credentials. Do not use the local acceptance config for deployment. Use the account that owns `traceyard-prod-db`; select the proper Cloudflare account through the CLI environment when needed.

After deployment, open Connections and review the execution workflow update for a connected repository. Complete a browser OAuth authorization from a remote HTTP MCP client; ask it to investigate a known failing supported test. Confirm its finding and source commit match the browser record. Repair through the coding agent, push the candidate and request verification. Inspect changed-test disclosure. If exercising replay, opt into capture, verify one eligible baseline recording and confirm reuse counts/no divergence on the candidate. Revoke the agent and confirm its access stops.

Record the deployed SHA from `/api/health`, the actual investigation and verification IDs, the GitHub check URL and grant revocation outcome before declaring live acceptance. Public discovery alone does not establish that full private journey. Additive schema migrations preserve existing executions; roll back Worker code separately if required and retain the migrated database rather than deleting investigation evidence.
