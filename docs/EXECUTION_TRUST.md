# Execution trust

Repository code is untrusted. That includes tests, npm install scripts, build scripts, the application under test, and any file in the checkout. This page lists what that code can and cannot reach in each hosted mode. It is tracked in [#80](https://github.com/fysaio/traceyard/issues/80).

Until every row below says "no", hosted results are reported as `HOSTED_UNATTESTED`. See the [evidence contract](../shared/contracts/evidence.ts).

## Credentials

| Credential                                      | Held by                                          | Passed to repository processes                                      |
| ----------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| GitHub App private key, Worker secrets          | Worker only                                      | No; never sent to a runner                                          |
| Installation token (managed checkout)           | Worker, during `git fetch`; revoked before tests | No                                                                  |
| Managed run credential `TRACEYARD_RUN_TOKEN`    | Agent                                            | No; removed from their environment, and traces go through the relay |
| Local key `TRACEYARD_KEY`                       | Agent                                            | No; same as above                                                   |
| GitHub OIDC request token and URL               | Agent (Actions)                                  | No; removed from their environment                                  |
| `github.token` (`TRACEYARD_GITHUB_FETCH_TOKEN`) | Agent (Actions), for `git fetch` only            | No; removed from their environment                                  |

"Passed to" covers the environment and command line of every process the agent starts. Removed names: `TRACEYARD_KEY`, `TRACEYARD_RUN_TOKEN`, `TRACEYARD_GITHUB_FETCH_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_*`, `ACTIONS_RUNTIME_*`, `ACTIONS_RESULTS_URL`, `ACTIONS_CACHE_URL`, `OTEL_EXPORTER_OTLP_*HEADERS` and `NODE_OPTIONS`. See `untrustedEnvironment` in [`agent/telemetry-relay.mjs`](../agent/telemetry-relay.mjs).

## Trace relay

Instrumented tests export OpenTelemetry spans to a relay on `127.0.0.1` inside the agent. The relay:

- accepts only `POST /v1/traces` with an OTLP/JSON body of at most 32 KB;
- forwards it only to `<origin>/api/v1/otlp/v1/traces`, with the agent's credential;
- never forwards headers from the caller.

Repository code can still send made-up spans through the relay. Spans are diagnostics, not verdicts.

## Repository configuration

`.env.traceyard` is repository content. Hosted runs never read it. Local runs read only `TRACEYARD_ORIGIN` and `TRACEYARD_KEY`, and never override a value already in the environment.

## Known gaps

These gaps are why hosted evidence is not yet attested:

- **Same operating-system user.** In managed checks and on GitHub Actions, repository processes run as the same user as the agent. On Linux, a process can read another process's original environment through `/proc/<pid>/environ` when both run as the same user. That holds even after the agent deletes the variable. Repository code can therefore still recover the agent's credential, or write to its output. The next step is to run repository processes as a separate, unprivileged user in the managed image.
- **GitHub Actions.** In GitHub Actions, the step's shell and the runner also hold the OIDC request token as the same user. A GitHub-hosted job cannot hide it from code that runs in the same job. Moving reporting to a separate trusted job, or to the managed supervisor, is tracked in #80.
- **Network.** Repository processes can reach the Traceyard origin and the internet. Without a credential they cannot post reports, but outbound network is not restricted.
