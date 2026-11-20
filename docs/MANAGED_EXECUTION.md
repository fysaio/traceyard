# Managed repository execution

## Architecture

GitHub App access supplies source reads and signed default-branch push notifications. Repository connection starts a persisted discovery Workflow. It refreshes the source index, then independently requests a managed check. Source errors and execution availability do not replace each other's state.

A check request snapshots the exact commit, repository identity and runner manifest in D1. An idempotency key is unique per project. D1 admission prevents repeated requests from launching extra jobs, limits project check frequency and admits a bounded global number of runners. The API returns the persisted check URL immediately.

The check's Durable Object starts one Cloudflare Container. Bootstrap uses a read-only, repository-scoped GitHub installation token to fetch the exact commit. It deletes Git metadata and revokes the token before starting repository scripts. The App private key and Worker secrets never enter the container. A short-lived opaque credential permits only configuration reads/reports/telemetry for that active check; D1 stores its hash. Finishing, cancelling, or expiring the check revokes that access.

The deployed image contains the reviewed Traceyard agent. The agent scans the checkout, installs npm dependencies and runs existing checks. Stage summaries and supported traces are uploaded. Raw container output is not persisted by the controller; known failures get safe summaries. This first version does not provide a complete hosted log viewer.

The controller destroys the container after completion, failure, or cancellation. A persisted start marker prevents automatic replay after an interrupted controller turn. A scheduled reaper closes expired records. The finite Container entrypoint bounds orphan cleanup. Cancellation does not prove that an external side effect was reversed.

## State boundaries

`project_repositories.scan_json` retains the last successful source index. `scan_progress_json` holds a replacement scan in progress. A failed replacement retains the successful index. A late report for an older commit cannot overwrite the current successful index or clear an active/failed source scan.

`repository_jobs` holds each check's phases and outcome. `managed_repository_checks` holds queue/admission, identity, immutable input and expiry. Application spans/results remain separate. A failed build is a failed check, not evidence that every source operation has failed. A test with no supported activity is not labelled a successful observed workflow.

Managed execution is optional and requires the managed configuration, Workers Paid with Containers enabled, an HTTPS non-local origin, and the required Durable Object/Container binding. Ordinary `npm run dev` is not managed mode. Without those prerequisites, the standard deployment uses the reviewed GitHub Actions workflow for repository tests and managed checks remain unavailable.

The runner smoke test builds `runner/Dockerfile` and executes the fixture inside that image. The managed image is built from the deployment checkout; `REVIEWED_RUNNER_REVISION` controls the GitHub workflow pin and does not automatically identify the managed image digest. See the [production release guide](PRODUCTION_RELEASE.md) for the standard hosted configuration.
