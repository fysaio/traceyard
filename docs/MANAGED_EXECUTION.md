# Managed repository execution

## Architecture

GitHub App access supplies source reads and signed default-branch push notifications. Repository connection starts a persisted discovery Workflow. It refreshes the source index, then independently requests a managed check. Source errors and execution availability do not replace each other's state.

A check request snapshots the exact commit, repository identity and runner manifest in D1. An idempotency key is unique per project. D1 admission prevents repeated requests from launching extra jobs, limits project check frequency and admits a bounded global number of runners. The API returns the persisted check URL immediately.

The check's Durable Object starts one Cloudflare container/VM. Bootstrap uses a read-only, repository-scoped GitHub installation token to fetch the exact commit. It deletes Git metadata and revokes the token before starting repository scripts. The App private key and Worker secrets never enter the container. A short-lived opaque credential permits only configuration reads/reports/telemetry for that active check; D1 stores its hash. Finishing, cancelling or expiring the check revokes that access.

The deployed image contains the reviewed Traceyard agent. The agent scans the checkout, installs npm dependencies and runs existing checks. Stage summaries and supported traces are uploaded. Raw container output is not persisted by the controller; known failures get safe summaries. This first version does not provide a complete hosted log viewer.

The controller destroys the container after completion, failure or cancellation. A persisted start marker prevents automatic replay after an interrupted controller turn. A scheduled reaper closes expired records. The finite container entrypoint caps an orphan VM's lifetime. Cancellation does not prove that an external side effect was reversed.

## State boundaries

`project_repositories.scan_json` retains the last successful source index. `scan_progress_json` holds a replacement scan in progress. A failed replacement retains the successful index. A late report for an older commit cannot overwrite the current successful index or clear an active/failed source scan.

`repository_jobs` holds each check's phases and outcome. `managed_repository_checks` holds queue/admission, identity, immutable input and expiry. Application spans/results remain separate. A failed build is a failed check, not evidence that every source operation has failed. A test with no supported activity is not labelled a successful observed workflow.

Legacy installed GitHub Actions report/status ingestion remains for existing history and migration. The setup/upgrade writer and generated workflow implementation have been removed. New connections do not write to customer repositories.

## Validation and release boundary

Automated coverage exercises actual CLI processes and measured HTTP spans, managed callback identity, frozen configuration, duplicate request races, failure retention, signed push handling and project isolation. It also checks ordinary Worker routes and the existing workflow engine. Test doubles stand in for Cloudflare container launch in integration tests. A separate CI job builds `runner/Dockerfile` and runs `scripts/verify-runner-image.mjs` inside the image as its non-root user, with external networking disabled. That job verifies actual successful/failed tests, installation failure, source reporting, command token isolation and measured HTTP span export using only a loopback fixture collector. Docker smoke tests do not establish Cloudflare provisioning or callback acceptance. The final local run passed all 137 unit tests and 138 Worker integration tests. TypeScript, lint, ordinary production build and managed configuration build passed. Actual Cloudflare VM launch remains unverified.

Before enabling this flow for users:

- Build and deploy the managed image in the intended Cloudflare account, apply migration 0013 and configure the App/public origin.
- Connect a disposable repository with read-only permissions. Verify download/install/build/test reporting and actual recorded HTTP activity with no repository writes.
- Exercise a failing install, missing runtime service, explicit retry, cancellation during a command and interrupted execution. Confirm the source index remains usable and old credentials cannot report.
- Push two commits and redeliver a webhook. Confirm the project settles on the current commit, duplicates do not launch another check and quota leaves discovery available.
- Verify VM destruction/queue/concurrency limits, billing and the full UI in a real browser.

No Cloudflare VM launch, paid deployment or fresh browser acceptance has been performed in this workspace. Do not treat mocked control-plane coverage as hosted execution sign-off. The PR records the current exact test results.
