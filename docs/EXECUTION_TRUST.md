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

## Managed checks: separate user

The managed controller runs the checkout as the image's unprivileged `node` user, so that user owns the workspace. Only the agent is started as `root`, with `TRACEYARD_SANDBOX_USER=1000:1000`. The agent then starts every repository command as that user, with supplementary groups dropped: install, build, test, request checks and the application. Repository code therefore cannot read the agent's `/proc/<pid>/environ` or `cmdline`, open its file descriptors, signal it, or modify the agent's files in `/opt/traceyard`.

The boundary fails closed. If `TRACEYARD_SANDBOX_USER` is set but the agent cannot confirm the switch with a probe process, it reports a failed check and runs no repository command. Files that repository code writes for the agent, such as reporter output, are read without following symbolic links.

The runner image check in CI ([`scripts/verify-runner-image.mjs`](../scripts/verify-runner-image.mjs)) runs this inside the built image. Its fixture test acts as a hostile test: it scans every `/proc/<pid>/environ` and `cmdline` in the container for the credential and fails if it finds it.

## Known gaps

These gaps are why hosted evidence is not yet attested:

- **GitHub Actions and local runs share a user.** There, repository processes run as the same user as the agent. On Linux, a process can read another process's original environment through `/proc/<pid>/environ` when both run as the same user. That holds even after the agent deletes the variable, so repository code can still recover the agent's credential or write to its output.
- **GitHub Actions.** In GitHub Actions, the step's shell and the runner also hold the OIDC request token as the same user. A GitHub-hosted job cannot hide it from code that runs in the same job. Moving reporting to a separate trusted job, or to the managed supervisor, is tracked in #80.
- **Network.** Repository processes can reach the Traceyard origin and the internet. Without a credential they cannot post reports, but outbound network is not restricted.
