# Frontend/backend integration

This branch replaces the old console with a React implementation of the rounded Traceyard interface. It uses the existing Worker on the same origin. There is no seed data, browser-generated run record, fake sign-in, local provider connection or client execution timer in the active application.

## Implemented paths

| User action | Backend contract |
| --- | --- |
| Sign in | GitHub OAuth authorization-code flow with PKCE via `/api/auth/github/start` and callback |
| Session and logout | `/api/auth/session`, `/api/auth/logout`; HttpOnly cookies, no browser tokens |
| Projects | List/create owned projects through `/api/projects` |
| Workflows | Published runtime catalog through `/api/workflows` |
| Reusable inputs | Owned saved workflow definitions, stored as version-pinned runtime/input configurations |
| Execute | `/api/runs`, project ID, validated document input, stable idempotency key |
| Inspect | Poll persisted run detail; steps, attempts, input, output, dispatch and errors |
| Events | All cursor pages of `/api/runs/:id/events`, included in trace export |
| Cancel/retry | Existing server-side cancellation and retry endpoints |
| Walkthrough | Manual inspection of recorded steps; never reruns or invokes external actions |
| Failure testing | Explicit retryable/permanent fault scenarios in the real Worker |
| Account security | List sessions and revoke other sessions |

Execution history is account-wide; project selection controls saving configurations and launch ownership. Workflow detail/Laboratory launches without an explicit project ID use the backend's default project. No unsupported project-history isolation is implied.

## What the backend actually executes

Only `document-intelligence` v1 is registered. Its operations validate input, normalize text, extract structured data deterministically, validate the extraction and persist the result. Cloudflare Workflows performs durable checkpoint/retry orchestration; D1 is the source of truth and Queue dispatch is retained. It is real server execution, but it is **not model inference**.

Saved definitions in the existing backend are not arbitrary executable code. The new frontend only enables saved configurations whose `runtimeWorkflowId` and `runtimeVersion` match the current catalog. Old graph definitions remain stored but cannot be launched as if they had a runtime.

The preview's generic Studio/graph publication, provider Gateway, approval tasks and webhooks are not exposed as working features. Implementing these requires additional backend execution contracts, authorization, version persistence and tests. The static chatgpt.site preview is a separate artifact and is not the backend deployment.

## Deployment prerequisites

The production app must serve frontend and API on the same origin. Do not point this frontend directly at a different origin: the existing same-origin mutation protection and cookies are intentional.

1. Authenticate Wrangler to the intended Cloudflare account, or supply its deploy token through the environment's secret configuration.
2. Confirm the D1 database, queue producer/consumer and Workflow binding in `wrangler.jsonc` belong to that account. Do not recreate or overwrite production resources blindly.
3. Apply the checked-in D1 migrations, after reviewing them, to the deployment database.
4. Register a GitHub OAuth app. Its callback must be `https://YOUR_APP_ORIGIN/api/auth/github/callback`.
5. Configure `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `PUBLIC_APP_ORIGIN` on the Worker. Use Wrangler secrets or the dashboard for credentials; never commit `.dev.vars`, tokens or secrets. `PUBLIC_APP_ORIGIN` is the exact HTTPS origin, without a path.
6. Run build and deploy using the repository scripts. Complete an actual sign-in, project creation, normal execution, trace inspection, cancellation/retry and sign-out smoke test on that deployed origin.

For local development, use `PUBLIC_APP_ORIGIN=http://localhost:5173` and a GitHub OAuth app registered to `http://localhost:5173/api/auth/github/callback`. Local migrations use `npm run db:migrate:local`; `npm run dev` runs both Vite and the Worker. Missing configuration produces an unavailable sign-in control, never a fake account.

## Validation and current limits

The Worker integration tests use actual Miniflare D1/Queue/Workflow bindings and stub GitHub's external token/profile responses. They cover OAuth callback/state verification, session ownership, cross-account isolation, persistence, dispatch, retry and cancellation. They are not evidence of a completed sign-in against GitHub production.

UI contract tests intentionally stub HTTP responses and are separate from those backend tests. The execution transport unit tests check cookie transport, project/idempotency data, expired-session errors, static-hosting misconfiguration and event pagination.

This workspace has no authenticated Cloudflare deployment session. Local interactive preview also failed because the Cloudflare Vite plugin encountered `uv_interface_addresses` in this environment; application code was not changed to bypass it. Browser/end-to-end production verification and production deployment remain pending. The public static UI preview remains unchanged.

## Executable Studio milestone (supersedes the document-only limit above)

Migration 0005 adds revisioned workflow drafts and immutable graph definitions on published versions. Studio now creates owned workflows, saves drafts using revision checks, validates and publishes versions, archives workflows without deleting run history, and opens historical published versions for inspection/launch.

The executable node set is Input, Literal JSON, Pick (safe field-path selection), Merge (ordered array of incoming values), and Output. Server validation rejects duplicate IDs, bad connections, cycles and disconnected paths. The graph executor uses Cloudflare durable steps and runs independent ready branches together; step results and failures use the existing D1 trace records. The document pipeline remains available separately.

Launch requests now select an explicit version and include project ownership in the idempotency request fingerprint. History can be filtered to an owned project; the frontend passes the current project through workflow, launch and history flows. Cancelled executions no longer advertise the failed-run-only retry endpoint. Account analytics now uses the existing backend metrics endpoints.

This milestone does not complete provider calls, external trace ingestion, nested spans, approvals, scheduled workflow triggers or outgoing webhooks. It is not ready for the final AntiGravity handoff. Runtime browser verification and production deployment remain pending for the previously recorded environment reasons.
