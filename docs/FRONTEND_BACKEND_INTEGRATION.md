# Frontend / backend contracts

The connected application journey and request-runner contracts are detailed in [project experience](PROJECT_EXPERIENCE.md). New owner-scoped APIs expose `/api/workspace/projects`, project `catalog`, `operations/:key`, `runner-config`, operation `cases`/`test`, `application-runs/:trace`, check detail/cancellation and a reviewable runner upgrade PR. `/api/v1/repository/configuration` supplies a project-scoped runner manifest/snapshot through the existing key or verified GitHub OIDC identity. Migration 0011 adds these configurations, case snapshots and retained results.

The React app and API run on one origin. Cookie-authenticated writes preserve origin checks. Project routes verify authenticated ownership; `/api/v1` routes require a scoped project API key, except repository runner reports and OTLP ingestion, which also accept a verified GitHub Actions OIDC identity restricted to the connected project. Missing configuration produces a setup/error state, never a generated account or fabricated result.

| Surface                   | Contract                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in / sessions        | `/api/auth/github/start`, callback, session, logout and session revocation                                                                                           |
| Projects                  | `/api/projects` owned list/create                                                                                                                                    |
| Studio                    | `/api/projects/:projectId/studio`, `/:id`, `/:id/publish`, `/import`                                                                                                 |
| Executable catalog        | `/api/workflows` and `/:id` with project/version selection                                                                                                           |
| Runs                      | `/api/runs`, `/:id`, `/:id/cancel`, `/:id/retry`, `/:id/events`                                                                                                      |
| External automation       | `/api/v1/runs`, `/:id`, `/:id/cancel`, `/api/v1/traces`                                                                                                              |
| Unified activity          | `/api/projects/:projectId/activity`; optional `checkRun` filters recorded application spans by runner identity                                                       |
| Repositories              | `/api/repositories`, `/api/repositories/connect` (create/reuse project), `/api/projects/:projectId/repository` and its `/scan`, `/analyze`, `/setup`, `/run` actions |
| Repository runner         | `/api/v1/repository/register`, `/api/v1/repository-runs`, `/api/v1/otlp/v1/traces`; signed `/api/github/webhook`                                                     |
| API keys                  | `/api/projects/:projectId/keys`, `/:id/revoke`                                                                                                                       |
| Traces                    | `/api/projects/:projectId/traces` and `/:traceId`; workflow evidence addressed as `execution:RUN_ID`                                                                 |
| Providers / routes        | Project `gateway`, `gateway/credentials/:provider`, `gateway/routes`, `gateway/routes/:id`, `gateway/playground`                                                     |
| Approval tasks            | Project `approvals` and `approvals/:id/decision`                                                                                                                     |
| Experiments               | Project `experiments` and `experiments/:id/launch`                                                                                                                   |
| Scheduled / outgoing work | Project `automations`, `schedules`, `webhooks`; resource `/:id` supports enable/disable and delete                                                                   |

Published graph JSON is immutable. Launch pins a published version and snapshots project-owned model routes in the same run bundle. Updating a route does not rewrite an accepted run; failed-run retry copies its original snapshot. Provider credentials remain project configuration and may be rotated/revoked independently. No provider secrets are embedded in graph exports or run snapshots.

Condition compares a selected input field to JSON and activates one of two configured outgoing edges. Exclusive descendants of the inactive edge are persisted as skipped. Merge collects active incoming results in connection order. Map selects fields from an array within its configured maximum. Graphs have at most 40 nodes, 120 edges, no cycles, one input/output and at most four approval steps. All published paths must remain connected.

Approval decisions update D1 conditionally before sending a Workflow wake-up. Repeated or late decisions conflict. A lost wake-up recovers at the next bounded one-minute wait timeout. Approval step attempts begin before waiting, so rejection/expiry has a visible failed step. Browser and API-key cancellation wake pending approvals.

External spans have nonzero W3C-shaped trace/span IDs. Ingestion checks parents for cycles, redacts known credential patterns and treats completed records as immutable. The SDK explicitly propagates parent context; it does not automatically capture function arguments/returns. Workflow traces project actual persisted run, step, attempt and model-request records into the same inspection shape; reads never invoke an action or manufacture timing.

Migration 0006 adds integration tables, scoped key metadata, captured route snapshots, and per-attempt input/output. It must be reviewed and applied to the intended database before enabling these routes. Existing owned saved configurations remain separate from executable Studio definitions.

Migrations 0008–0010 add repository installation, discovery and independent test-setup/dispatch state. The `REPOSITORY_DISCOVERY` Workflow binding runs bounded source scans. See [repository setup](REPOSITORY_SETUP.md) for installation permissions, runner identity checks, support boundaries and deployment instructions.

No production secrets, live OAuth login, provider smoke test, remote migration or deployment has been completed here. The product repair includes a scoped local browser journey, described in PRODUCT_EXPERIENCE_REPAIR.md; this is not complete all-screen/device acceptance. The old chatgpt.site preview is separate and has not been updated to pretend it is this Worker.
