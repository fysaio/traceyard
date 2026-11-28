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

"Passed to" covers the environment and command line of every process the agent starts. The child-environment filter removes reporting credentials, GitHub/OIDC credentials, inherited TraceYard run/origin metadata, and GitHub output-file channels. It also removes caller-supplied `NODE_OPTIONS` and OTLP headers. The agent adds only the operational values required for tracing, request-result collection, and interaction capture after filtering; repository-provided values cannot replace those destinations. See `untrustedEnvironment` in [`agent/telemetry-relay.mjs`](../agent/telemetry-relay.mjs).

## Mode-by-mode boundary and evidence matrix

The matrix below is the boundary for the claims TraceYard makes today. “Limited” means a control exists but does not establish an independent trust boundary. A hosted pass is never attested while any row for its mode remains limited or unknown.

| Mode              | Credentials and control-plane metadata                                                                                                                                        | Process/user boundary                                                                                                                        | Filesystem and output boundary                                                                                                          | Network egress                                                                                              | Who creates the report                                               | Evidence level and claim                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Local CLI         | Reporting values are filtered from child environments, but the repository and agent share a user. Same-user process metadata can still expose original values.                | Limited: repository code runs as the same user as the agent.                                                                                 | Limited: repository code can access other same-user process metadata and local output paths.                                            | Unrestricted; no deny/allowlist is enforced.                                                                | The selected test process and local runner.                          | `LOCAL_PROVISIONAL`, `FOCUSED`; never hosted attestation or merge proof.                       |
| GitHub Actions    | OIDC and fetch-token values are filtered from child environments, but the workflow shell and repository share a user; the token is bounded only to that run/attempt/revision. | Limited: repository code runs as the same user as the workflow runner.                                                                       | Limited: same-user `/proc` and workflow output channels remain a known boundary.                                                        | Unrestricted by TraceYard.                                                                                  | The repository test process in the workflow.                         | `HOSTED_UNATTESTED`, `FOCUSED`; not a merge approval.                                          |
| Managed container | Checkout credentials are used only for bootstrap and revoked before repository commands. The run credential is held by the root agent and filtered from repository processes. | Protected for the tested boundary: the agent is root and repository commands run as `node` (`1000:1000`), with supplementary groups dropped. | Protected for agent files and process metadata; repository-owned report files remain untrusted and are read without following symlinks. | Limited: the managed runner currently enables internet access and has no TraceYard-enforced deny/allowlist. | The repository test process writes the report consumed by the agent. | `HOSTED_UNATTESTED`, `FOCUSED`; the separate-user boundary does not attest report correctness. |

The managed container row is deliberately not described as fully isolated: the separate-user boundary protects the agent credential and control-plane files, but it does not restrict outbound network access or make a test-generated report independent. The deterministic runner-image check uses Docker `--network none` only as packaged-image/process-boundary evidence; it is not evidence that the production managed container has the same network policy.

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

## Test inputs

A pass only counts as a fix when nothing changed how the test runs. `traceyard verify` and hosted verification share one set of rules, in [`packages/core/src/test-inputs.mjs`](../packages/core/src/test-inputs.mjs). They flag:

- tests, fixtures, snapshots and mocks;
- setup files such as `vitest.setup.ts`, `jest.setup.js`, `setupTests.ts` and `*.setup.ts`;
- Vitest, Vite and Jest config and workspace files;
- Pytest modules, `conftest.py` and Pytest or dependency configuration.

Each JavaScript run also records a digest of its runner configuration. The digest covers the package script that ran, the `jest` key in `package.json`, and the contents of any file the script names with `--config` or `-c`. When the two runs' digests differ, `package.json` is reported as a changed test input. This catches a fix commit that points the test script at a lenient config, or edits a config file whose name matches no rule. When only one run has a digest, for example a baseline from an older runner, the comparison is recorded as a limitation. If `package.json` also changed, it is flagged as a changed test input.

Hostile fix commits for each of these cases are kept as fixtures in [`tests/unit/adversarial-evidence.test.ts`](../tests/unit/adversarial-evidence.test.ts). Files that a config imports, rather than names, are not followed.

## Known gaps

These gaps are why hosted evidence is not yet attested:

- **GitHub Actions and local runs share a user.** There, repository processes run as the same user as the agent. On Linux, a process can read another process's original environment through `/proc/<pid>/environ` when both run as the same user. That holds even after the agent deletes the variable, so repository code can still recover the agent's credential or write to its output. These modes remain `LOCAL_PROVISIONAL` or `HOSTED_UNATTESTED`; only the managed container has the separate-user credential boundary.
- **GitHub Actions.** In GitHub Actions, the step's shell and the runner also hold the OIDC request token as the same user. A GitHub-hosted job cannot hide it from code that runs in the same job. The damage is bounded to that run. The server accepts a GitHub token only for its own workflow run and attempt at its own commit, and it rejects reports, recordings and index uploads for any other run or revision. A second job in the same workflow gets a token with the same claims, so a separate reporting job would not change what the server can check.
- **Results come from the test process.** Vitest and Jest write their structured report from inside the process that runs repository code, and Pytest reports through a plugin in that process. In every mode, including managed checks, code under test can write a passing report and exit. That is no stronger than code that detects the test and returns the expected value, which no test runner can rule out. Traceyard's claims stay focused for this reason. They say the selected test reported a pass at an exact commit, not that the behavior is correct.
- **Network.** Repository processes can reach the Traceyard origin and the internet in local, GitHub Actions, and managed execution. Without a credential they cannot post reports, but outbound network is not restricted or allowlisted by TraceYard. Hosted evidence therefore remains `HOSTED_UNATTESTED`; no network-isolation claim is made.
