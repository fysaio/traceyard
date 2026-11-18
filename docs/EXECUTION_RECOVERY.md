# Execution and recovery

Traceyard executes published, bounded DAG workflows. Model steps call configured providers; HTTP steps call allowed HTTPS JSON endpoints. Approval steps pause for an owner decision. Creating and executing a workflow with local transformations or approval steps requires no application API key or customer repository modification. Calling a protected external service requires that service's authentication; source discovery cannot supply missing credentials.

## Recovery contract

`POST /api/runs/:id/retry` accepts `{ "mode": "resume" }` or `{ "mode": "restart" }`. No body preserves the existing restart behavior. The scoped server API exposes the same operation at `/api/v1/runs/:id/retry` with `runs:write` authorization. A key may only recover an execution in its own project. Recovery accepts no input or version overrides.

Only failed runs can be recovered. The new run retains the original input, version, model-route snapshot and HTTP-destination snapshot. Run creation, checkpoint copies, provenance events, dispatch outbox and original-to-recovery link commit in one D1 transaction. One recovery child is allowed per failed execution; a failed child may itself be recovered. Concurrent attempts cannot create multiple children.

For invalid input, **Edit input and run** creates a linked fresh execution of the same published version. It re-executes every step, retaining no checkpoints, and keeps the original failure untouched. The launch API accepts `parentRunId` and verifies that the source execution belongs to the caller, project and workflow. This lineage is included in the launch idempotency hash. A different published version can be selected explicitly through the launch API. This is distinct from resuming unchanged work.

Resume copies successful step outputs, with `reusedFromRunId` provenance. It does not copy failed attempts or fabricate successful attempts. Reused steps have zero attempts and null execution timestamps/duration. Their `step.reused` event identifies the source run. Failed, skipped and unfinished steps are evaluated again; cached condition outputs rebuild branch selection. Completed approvals are reused before entering the approval service. The built-in document pipeline re-commits its final output for the new run instead of reusing its database commit step.

Restart copies no checkpoints and assigns a new HTTP effect scope. It can repeat completed external actions. The UI requests confirmation for this operation. Resume preserves the HTTP effect scope across recovery chains, so the same node uses the same idempotency key even if an earlier request completed remotely but its response was lost. The destination must implement idempotency for this to prevent duplicate effects. Provider calls may incur repeated costs when no retained successful result exists.

Deleted HTTP connections prevent unfinished HTTP calls from executing; completed HTTP checkpoints remain usable. Provider credential rotation/revocation continues to apply at execution time. Recovery does not manufacture credentials, change business logic or replace application errors with success.

## Automatic retry

HTTP/model nodes may set `config.retry` to `{ "maxAttempts": 3, "baseDelayMs": 1000, "backoff": "exponential" }`. Maximum attempts is 1–5; delays are 100–30,000 milliseconds before exponential growth. Default is one attempt. Studio exposes maximum attempts with a one-second exponential base. Publication and execution derive the same policy from the immutable graph.

HTTP 429, 5xx and network failures carry retryable dependency errors. Other HTTP failures and invalid JSON responses stop immediately. Every actual attempt has its own retained input/output and failure evidence. Provider gateway failures retain the existing provider fallback behavior; a configured step policy may retry a gateway-unavailable error. Configuration/validation errors do not automatically retry.

## Inspection outside the browser

`GET /api/v1/runs/:id/events?after=0&limit=200` returns persisted events and a cursor, with project-scoped `runs:read` authorization. `TraceyardClient.events(id, after)` reads a page; `TraceyardClient.retry(id, "resume")` recovers an execution. The CLI supports `resume` and `restart` alongside launch, inspection and cancellation.

## Verification and deployment

The recovery integration suite executes the actual graph executor against migrated D1 with controlled HTTP responses. It checks a 503 failure followed by successful recovery, completed HTTP effect suppression, stable idempotency keys, permanent-failure handling, separate retry attempts, owner/project isolation and retained failure history. Another test executes recovered conditional checkpoints through the actual local Cloudflare Workflow binding. Controlled HTTP tests do not establish remote-provider behavior or exactly-once delivery.

The operator deployed revision `90206d8` with migration `0015_execution_recovery.sql`. Actual production document execution, transient retry, checkpoint reuse and linked fresh execution were verified through the API. Authenticated browser acceptance remains blocked by a GitHub callback failure. See [live evidence](LIVE_VERIFICATION_2026-11-18.md) for the exact scope. No paid infrastructure is introduced.
