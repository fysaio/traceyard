# Traceyard

Traceyard is an execution intelligence and reliability platform for workflows, background jobs and AI agents. This repository contains a working Cloudflare-native implementation: a durable execution engine, a persisted execution ledger, a queue-backed dispatch outbox, and a dark React console for inspecting real runs.

The public sandbox executes one deterministic document-intelligence workflow. It is a real execution path — every run, step, attempt, event, dispatch and output shown in the console is persisted in D1. There are no fabricated metrics, fake progress bars or client-side simulation.

> Status: local implementation, migrations applied to the **local** D1 only. Nothing has been deployed and the remote `traceyard-prod-db` has not been migrated.

## What is implemented

- **Durable Workflows execution** — five checkpointed steps with per-step retry policy, timeouts and deterministic failure injection.
- **Transactional launch** — a run, its steps, dispatch outbox row, event stream entries and audit event are committed in one D1 batch.
- **At-least-once dispatch** — the queue consumer claims the outbox row and creates a Cloudflare Workflow instance whose ID is the run ID, making duplicate delivery and redelivery idempotent.
- **Dispatch reconciliation** — a five-minute cron republishes stale outbox rows, reopens stale claims, fails exhausted dispatches, times out stuck queued runs, expires old data and evaluates the sandbox circuit breaker.
- **Validated state machine** — run and step transitions use conditional SQL updates with expected current states. The schema itself also constrains valid status values.
- **Cancellation and retry** — queued runs cancel immediately; running runs move to `CANCELLING` and finalize at the next step checkpoint. Retry creates a new run with a unique `retry_of_run_id` and a preserved scenario.
- **Private anonymous sandbox** — HttpOnly session cookie, only a SHA-256 hash persisted, hashed IP/user-agent fingerprints, bounded input, strict Zod validation, server-side quotas and a circuit breaker.
- **Real analytics** — success rates, percentiles, throughput and failure classes computed from D1 over a configurable window. Small samples are shown as-is.
- **Tested surfaces** — unit domain tests, integration tests running the actual Worker in Miniflare with D1/Queues/Workflows, and Playwright tests against the real dev server.

## Architecture

```
Browser (React + TanStack Query)
        │  same-origin JSON
        ▼
Cloudflare Worker (Hono)
  ├─ session / CSRF-origin / security headers
  ├─ POST /api/runs ──────────────► D1 batch:
  │                                   run + steps + dispatch outbox
  │                                   + events + audit
  │                                        │
  │                                        ▼
  │                                  EXECUTION_QUEUE ──► consumer claims
  │                                                        dispatch and
  │                                                        creates Workflow
  │                                                        (id = runId)
  │                                                            │
  │                                                            ▼
  │                                                   RunExecutionWorkflow
  │                                                   (5 durable steps)
  │                                                            │
  └─ GET APIs ◄────────────── D1 (system of record) ◄──────────┘

Cron (*/5) ──► reconciliation, cleanup, circuit breaker
```

D1 is the system of record for all product state. The queue is a delivery mechanism, not a source of truth; anything the queue fails to deliver is recoverable from the outbox by reconciliation.

### Run lifecycle

```
QUEUED ──dispatch──► RUNNING ──success──► SUCCEEDED
   │                    │
   │                    ├──terminal failure──► FAILED
   │                    └──cancel request────► CANCELLING ──checkpoint──► CANCELLED
   └──cancel request────────────────────────────────────────────────────► CANCELLED
```

`FAILED` is a terminal application/infrastructure outcome. A retry is a **new run**, linked by `retry_of_run_id`; it never mutates the original run.

## Reliability semantics

| Concern           | Guarantee in this build                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Run acceptance    | A run is visible only after its complete bundle is committed in one D1 batch.                                                     |
| Queue delivery    | At-least-once. Duplicate messages are acknowledged without creating a second Workflow instance.                                   |
| Workflow creation | `id = runId`, so repeated creates resolve to the same instance.                                                                   |
| Step execution    | Each step is a durable checkpoint. Attempts are persisted individually.                                                           |
| State transitions | Conditional `UPDATE ... WHERE status = expected`, with schema-level status checks.                                                |
| Cancellation      | Cooperative: checked between steps. A step already running is not forcibly interrupted.                                           |
| Side effects      | No exactly-once claim for external side effects. D1 commits are idempotent; external calls would need their own idempotency keys. |
| Data retention    | Runs expire after 30 days by default and are deleted with dependent rows; audit events are retained for 90 days.                  |

## Sandbox limits

The sandbox is deliberately narrow:

- only the compiled `document-intelligence` workflow can execute; a D1 catalog row cannot add executable code;
- no arbitrary URLs, network calls or user-supplied code;
- request bodies are capped at 32 KB and validated with a strict schema;
- document text is capped at 10,000 characters;
- per-session hourly/daily, per-IP hourly, global daily and active-concurrency quotas are reserved atomically before a run is accepted;
- the circuit breaker opens after repeated infrastructure failures and returns `503` with `Retry-After`;
- runs are private to the anonymous browser session that created them.

Default limits (see `wrangler.jsonc`):

| Limit               | Default                       |
| ------------------- | ----------------------------- |
| Session daily runs  | 20                            |
| Session hourly runs | 6                             |
| IP hourly runs      | `max(12, session hourly × 2)` |
| Global daily runs   | 100                           |
| Active concurrency  | 8                             |
| Retention           | 30 days                       |

## Stack

React 19 · Vite 8 · TypeScript (strict) · Tailwind CSS 4 · shadcn/ui-style components · Lucide · TanStack Query · React Router · Zod · Hono · Cloudflare Workers · D1 · Queues · Workflows · Vitest · Playwright · ESLint · Wrangler.

## Quick start

Requirements: Node.js ≥ 22.12 and npm.

```bash
npm ci
npm run db:migrate:local
npm run dev
```

Open <http://localhost:5173>. The console starts empty for a new anonymous session. Use **Launch run** to execute the document workflow, then inspect its steps, attempts, events, input and committed output.

Useful local commands:

```bash
npm run typecheck        # TypeScript project references
npm run lint             # ESLint
npm run test             # unit + integration
npm run test:e2e         # Playwright against the dev server
npm run build            # typecheck + production build
npm run bench:api        # read-only latency probe (dev server must be running)
```

The Playwright config starts the dev server and applies local migrations automatically. It uses an installed branded Chrome when available and otherwise falls back to Playwright's managed Chromium (`npx playwright install chromium`).

### API

All endpoints are under `/api` and are session-scoped unless noted.

| Method | Path               | Purpose                                             |
| ------ | ------------------ | --------------------------------------------------- |
| `GET`  | `/health`          | Worker, D1, queue and workflow binding health       |
| `GET`  | `/workflows`       | Executable workflow catalog                         |
| `GET`  | `/workflows/:id`   | Workflow metadata and step manifest                 |
| `POST` | `/runs`            | Launch a run (requires `Idempotency-Key` header)    |
| `GET`  | `/runs`            | Paginated run list with status/workflow filters     |
| `GET`  | `/runs/:id`        | Run detail: steps, attempts, dispatch, input/output |
| `GET`  | `/runs/:id/events` | Cursor-paginated event stream                       |
| `POST` | `/runs/:id/cancel` | Request cancellation                                |
| `POST` | `/runs/:id/retry`  | Create a retry run for a failed execution           |
| `GET`  | `/overview`        | Dashboard totals, trend, recent runs, quotas        |
| `GET`  | `/analytics`       | Percentiles, throughput and failure classes         |
| `GET`  | `/sandbox`         | Current session/deployment sandbox status           |

Example launch:

```bash
curl -X POST http://localhost:5173/api/runs \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 6f1c2e5a-run-0001" \
  -d '{
    "workflowId": "document-intelligence",
    "scenario": "success",
    "input": {
      "title": "Incident review",
      "document": "A bounded document with at least 24 characters."
    }
  }'
```

Mutations require a same-origin browser context. Use the console for anonymous sandbox runs.

## Verification

The repository currently has:

- **54 unit tests** — state transitions, retry arithmetic, cursor encoding, document normalization/extraction/digest, error serialization.
- **50 integration tests** — the real Worker running in Miniflare with D1, Queues and Workflows: API validation, idempotency, session isolation, pagination, cancel/retry, quotas, success/retry/terminal failure/cancellation/recovery, queue duplicates, outbox behavior, reconciliation, cleanup and circuit breaker.
- **4 Playwright tests** — honest empty state, real launch to successful completion, terminal failure plus retry lineage, and navigation across every console surface.

```bash
npm test
npm run test:e2e
```

Local read-only benchmark against `npm run dev` (Miniflare, Node 22, 30 requests per path, concurrency 4). These are **local relative numbers**, not production capacity:

| Endpoint                | p50     | p95     | p99     | Throughput |
| ----------------------- | ------- | ------- | ------- | ---------- |
| `/api/health`           | 43.4 ms | 61.7 ms | 68.1 ms | 82.7 req/s |
| `/api/workflows`        | 44.1 ms | 54.6 ms | 54.9 ms | 87.8 req/s |
| `/api/overview?days=14` | 88.0 ms | 92.9 ms | 93.0 ms | 44.5 req/s |

## Project layout

```
worker/
  api/            Hono app, middleware, routes
  execution/      Workflow class, step executor, finalization
  jobs/           scheduled reconciliation and cleanup
  persistence/    D1 repositories and validated transitions
  queue/          producer and consumer
  services/       launch/cancel/retry, analytics, quotas
shared/
  contracts/      API response types
  domain/         status, retry policy, errors, time
  workflow/       deterministic document workflow
src/
  components/     app shell, tables, timeline, dialogs, UI primitives
  pages/          overview, executions, detail, workflows, analytics, settings
migrations/       D1 schema and catalog seed
tests/
  unit/           pure domain tests
  integration/    Miniflare Worker tests
  e2e/            Playwright console tests
```

## Deploying

The repository is already configured for the existing Cloudflare resources:

- D1 `traceyard-prod-db` (`cae223eb-3992-40dc-b04d-d3d2946a6e1e`)
- Queue `traceyard-executions`
- Workflow `traceyard-run-execution`

Deployment requires explicit approval and a remote migration:

```bash
npm run db:migrate:remote
npm run deploy
```

**These commands have not been run against the remote account.** The remote database has no Traceyard tables yet. Create/verify resources before deploying and do not create duplicate D1 or Queue resources.

## Known limitations

- Cancellation is cooperative at step boundaries; a step in progress is allowed to finish.
- External side effects are not implemented, so exactly-once behavior for them is not demonstrated.
- The sandbox is single-workflow and anonymous only; there are no accounts, organizations, public galleries or cross-session comparisons.
- Analytics is computed on request from D1 and is suitable for the sandbox scale, not for unbounded production history.
- The local benchmark measures Miniflare on one machine and should not be used as a capacity plan.
- Queue dispatch can be delayed by cron reconciliation if a publish is lost; the outbox is designed to recover, not to eliminate latency.

## License

MIT. See [LICENSE](./LICENSE).
