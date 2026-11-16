# Traceyard

Traceyard builds and runs durable workflows, records what happened at each step, and helps investigate failures. The React interface talks to the Hono Worker on the same origin. D1 stores account, project, workflow, execution and integration state; Cloudflare Queues dispatches work and Workflows checkpoints execution.

This branch contains the integrated application. The separate chatgpt.site UI preview is not the backend deployment. No production deployment or remote migration has been performed from this workspace.

## Product flow

The connected application UI now follows **Projects → Project → Operation → Run**, with saved local request tests, actual execution timelines, check progress, comparison and in-context test settings. See [project experience](docs/PROJECT_EXPERIENCE.md) for implemented actions, evidence rules and verification limits.

**Connect repo** creates or opens its project and starts source discovery. On a managed deployment, Traceyard downloads the selected commit into its own temporary runner and executes supported checks. No customer repository changes or setup PR are required. Default-branch pushes refresh discovery and request bounded checks. A failed check leaves source operations available.

**Project** is now the main workspace: connect source, inspect discovered operations, review project checks and investigate actual application runs in one place. External spans and Traceyard-managed runs share the same activity list; selecting an external run opens its steps beside it. **Build** retains the optional workflow editor. Gateway and workflow experiments remain available through the account menu.

Repository-first installation and the local CLI are described in [repository setup](docs/REPOSITORY_SETUP.md). This is an initial personal-GitHub/Node implementation: source discovery is bounded, runtime recording covers supported Node libraries, and the runner executes existing npm scripts. A public HTTPS deployment and GitHub App configuration are required for hosted checks. The managed Cloudflare container path still needs deployed acceptance. Arbitrary visual-to-code edits and automatic business-logic fixes are not implemented.

| Screen                   | Working behavior                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Workflows / Studio       | Revisioned drafts, graph editing, connections, validation, JSON import/export, immutable publication, historical versions and archival |
| Executions               | Version-pinned launches, project history, cancellation, failed-run retry, payload/attempt evidence, event pagination and JSON export   |
| Traces                   | Workflow evidence plus external nested spans, redaction, searchable recent history and operation inspection                            |
| Gateway                  | Encrypted provider credentials, revisioned model/fallback routes, real request playground and recorded provider usage                  |
| Approvals                | Durable waiting tasks, owner decisions, expiry, cancellation and resumption                                                            |
| Laboratory               | Stored experiment definitions, bounded repeat groups, real assertions and side-by-side execution comparison                            |
| Settings / project tools | Sessions, scoped API keys, schedules, outgoing completion webhooks and delivery results                                                |

Studio supports Input, Literal JSON, Pick, Merge, Output, Condition, bounded Map, Model, Approval, Parse JSON and HTTP Tool. Parse checks JSON and required fields. HTTP Tool calls a project-owned, allowlisted HTTPS JSON destination configured under Settings → HTTP connections, with optional encrypted bearer credentials. The destination/method are captured at launch; deleting the connection prevents later requests that need its credential. Condition executes one connected path and skips the other; Merge joins the surviving results. Map selects a field from each array item, up to 20 items. Model uses a project-owned Gateway route captured at launch. Up to four approval steps can wait for an owner decision, for at most an hour each. Independent ready steps run together.

The compiled document pipeline also remains available. Its extraction is deterministic. Controlled retryable/permanent extraction faults are restricted to that pipeline; they are deliberately selected tests, not provider inference.

## Local setup

Requirements: Node.js ≥22.12, npm, and a GitHub OAuth application for your local origin.

```bash
npm ci
npm run dev
```

`npm run dev` applies outstanding local migrations before starting Vite. Open <http://localhost:5173>. Create an ignored `.dev.vars` file with:

```text
PUBLIC_APP_ORIGIN=http://localhost:5173
GITHUB_CLIENT_ID=<your OAuth app client ID>
GITHUB_CLIENT_SECRET=<your OAuth app secret>
INTEGRATION_ENCRYPTION_KEY=<base64 encoding of 32 random bytes>
OUTBOUND_ALLOWED_HOSTS=hooks.your-domain.example
```

Register `http://localhost:5173/api/auth/github/callback` on the GitHub OAuth app. Use a separate production OAuth configuration for the deployed HTTPS origin. Account features require real sign-in; missing OAuth configuration never creates a fake user. Explore sandbox runs the compiled document pipeline anonymously. For isolated UI acceptance without GitHub credentials, see [local acceptance](docs/LOCAL_ACCEPTANCE.md).

Provider keys are entered in Gateway, encrypted with AES-GCM and project-bound authenticated context, and never returned by credential metadata endpoints. Workers AI also requires your Cloudflare account ID. Keep the encryption master key stable and backed up securely; changing it makes existing encrypted credentials unreadable. Configure outgoing destination hosts explicitly before creating webhooks.

## SDK and CLI

Copy [`sdk/client.ts`](sdk/client.ts) directly into a server project. There is no claimed published npm/Python package. The client supports nested spans and W3C traceparent helpers, launch, inspection and cancellation. Telemetry delivery failures do not change the wrapped application's return value or error.

Create a project API key in Settings → API keys & SDK. Keep it in a server environment, never browser storage. Keys expire after 90 days, are revocable, store only a hash, and grant selected `traces:write`, `runs:read` and `runs:write` scopes. Rate limit: 120 requests/minute/key.

```bash
node scripts/traceyard.mjs run YOUR_WORKFLOW_ID --version 1 --input input.json --idempotency-key order-00001
node scripts/traceyard.mjs inspect RUN_ID
node scripts/traceyard.mjs cancel RUN_ID
node scripts/traceyard.mjs list
```

Set `TRACEYARD_ORIGIN` and `TRACEYARD_KEY` in the invoking environment. HTTP endpoints live under `/api/v1`; browser-owned configuration APIs live under `/api/projects/:projectId`.

## Reliability and limits

Run acceptance commits a complete D1 bundle, including captured model routes. Queue delivery is at least once and uses the run ID as the Workflow instance ID. Retry creates a new execution and retains the original published graph and captured model route configuration. Cancellation is cooperative; a provider request already in flight may finish before the next checkpoint.

Provider calls and webhook delivery can repeat after infrastructure interruption. Traceyard does not claim exactly-once external side effects. Webhooks use a stable delivery ID, HMAC-SHA256 signature and bounded retries; receivers must verify signatures/timestamps and deduplicate deliveries. Schedules are evaluated by the five-minute cron and do not backfill missed intervals.

The existing shared admission budget still applies: 100 runs/day, 8 active executions, 6/hour/session and 20/day/session by default. Experiment groups can therefore partially launch; “Continue launches” resumes remaining trials. Gateway separately limits a project to 60 model requests/hour. Rates entered on model routes produce estimates from reported token counts; they are not billed charges. Missing provider usage/cost stays unavailable.

Runs and external spans retain 30 days by default; audit events retain 90. Trace views show the latest 100 traces and up to 1,000 external spans per trace. Redaction covers known credential field names and common token patterns; callers must avoid sending unnecessary sensitive attributes. Projects are owner-scoped. Team roles, arbitrary user code, specialized CRM/search adapters, OpenTelemetry OTLP ingestion, and a published package registry are outside this build.

## Validation and deployment

```bash
npm test
npm run lint
npm run build
npm run test:e2e
```

Unit and integration tests exercise the actual Miniflare D1, Queue and Workflow bindings. GitHub/provider HTTP responses are test doubles where an external service is involved; these are not live credential verification. The earlier product repair checkpoint passed 68 unit tests and 84 Worker integration tests; the repository-runner change adds source discovery, runner and identity checks. A local browser journey created and switched projects, used a template, published a graph, executed it and inspected persisted output. See [repair evidence and limits](docs/PRODUCT_EXPERIENCE_REPAIR.md). Browser contract test files exist but were not executed through the Playwright runner in this environment. Live GitHub OAuth, provider calls, physical touch-device QA and a complete all-screen browser audit remain unverified.

See [implementation status](docs/IMPLEMENTATION_STATUS.md), [integration contracts](docs/FRONTEND_BACKEND_INTEGRATION.md) and [local acceptance checks](docs/LOCAL_ACCEPTANCE.md). Review the repair PR and run the remaining configured-service and device acceptance checks before treating the app as release-ready. Review migrations and intended Cloudflare resource IDs before deployment; never replace production resources to make setup pass.
