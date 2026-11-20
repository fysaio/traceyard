# Frontend / backend contracts

The browser and [MCP server](MCP.md) share repository investigations and their test evidence. In this document, **project** names the owner-scoped backend resource; the current user-facing UI calls the connected resource a **repository**.

The connected application journey and request-runner contracts are detailed in [project experience](PROJECT_EXPERIENCE.md). New owner-scoped APIs expose `/api/workspace/projects`, project `catalog`, `operations/:key`, `runner-config`, operation `cases`/`test`, `application-runs/:trace`, check detail/cancellation and managed check launch. `/api/v1/repository/configuration` supplies a project-scoped runner manifest/snapshot through a scoped local key, active managed credential or verified legacy GitHub OIDC identity. Migration 0011 adds these configurations, case snapshots and retained results.

The React app and API run on one origin. Cookie-authenticated writes preserve origin checks. Project routes verify authenticated ownership; `/api/v1` routes require a scoped project API key, except repository runner reports and OTLP ingestion, which also accept an active managed check credential or a legacy verified GitHub Actions OIDC identity restricted to the connected project. Missing configuration produces a setup/error state, never a generated account or fabricated result.

| Surface             | Contract                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in / sessions  | `/api/auth/github/start`, callback, session, logout and session revocation                                                                                           |
| Projects            | `/api/projects` owned list/create                                                                                                                                    |
| External automation | `/api/v1/traces`                                                                                                                                                     |
| Unified activity    | `/api/projects/:projectId/activity`; optional `checkRun` filters recorded application spans by runner identity                                                       |
| Repositories        | `/api/repositories`, `/api/repositories/connect` (create/reuse project), `/api/projects/:projectId/repository` and its `/scan`, `/analyze`, `/setup`, `/run` actions |
| Repository runner   | `/api/v1/repository/register`, `/api/v1/repository-runs`, `/api/v1/otlp/v1/traces`; signed `/api/github/webhook`                                                     |
| API keys            | `/api/projects/:projectId/keys`, `/:id/revoke`                                                                                                                       |
| Traces              | `/api/projects/:projectId/traces` and `/:traceId`                                                                                                                    |

External spans have nonzero W3C-shaped trace/span IDs. Ingestion checks parents for cycles, redacts known credential patterns and treats completed records as immutable. The SDK explicitly propagates parent context; it does not automatically capture function arguments/returns.

Migrations 0008–0010 add repository installation, discovery and independent test-setup/dispatch state. The `REPOSITORY_DISCOVERY` Workflow binding runs bounded source scans. See [repository setup](REPOSITORY_SETUP.md) for installation permissions, runner identity checks, support boundaries and deployment instructions.

Production behavior is environment-specific and must be verified against the deployed revision and release record. Local tests are separate from authenticated live acceptance; this contract document does not treat an undated historical deployment assertion as current evidence.

The standard deployment uses GitHub checks with in-app setup approval, backed by migration 0014. `/repository/analyze` requests an actual GitHub check, while `/repository/scan` refreshes source only. Optional managed Containers are a separate deployment mode and are not required. Signed default-branch pushes refresh connected source.
