# Implementation status

Traceyard is an open-source platform for executing, observing, debugging, and recovering workflows and AI agents. The main journey is Workflows → Execution → Step evidence → Recovery. Repository source discovery and CI checks support that journey.

| Area                  | Implemented                                                                                                         | Verification boundary                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Workflows             | Project-owned drafts, immutable versions, graph validation, templates, JSON import/export and Studio                | Local API/execution tests; current navigation needs authenticated browser acceptance                                         |
| Execution             | Durable DAG, parallel dependencies, conditions, bounded field mapping, model routes, HTTP tools and owner approvals | Actual local Cloudflare Workflow binding; remote model/HTTP receivers require live verification                              |
| Recovery              | Linked resume/restart, retained input/version/route snapshots, checkpoint provenance, stable HTTP effect identity   | Migrated D1 and controlled failure/recovery tests; migration 0015 deployed; production document checkpoint recovery verified |
| Debugging             | Per-step input/output, typed HTTP failures, separate attempts, event pagination, comparisons and export             | Local tests; no claim of complete mobile/all-screen acceptance                                                               |
| Observation           | External nested spans, scoped ingestion, OTLP HTTP JSON and supported Node instrumentation                          | Successful hosted CI was observed; that run recorded no application traces                                                   |
| Integrations          | Encrypted provider credentials, model fallback, schedules, completion webhooks, server SDK and CLI                  | Test coverage does not prove remote service behavior                                                                         |
| Repository connection | Existing installation recovery, bounded source inference, in-app GitHub setup approval and dispatch                 | Operator deployed 90206d8 and migration 0015; signed-in browser verification hit a GitHub callback error                     |

Standard Cloudflare deployment does not require paid Containers. The managed-container mode remains optional and unverified live. Arbitrary source functions are not automatically executable workflow definitions. Source inference is not runtime evidence. HTTP idempotency requires receiver support; exactly-once external effects are not claimed.

See [execution recovery](EXECUTION_RECOVERY.md) for the current contract and [repository setup](REPOSITORY_SETUP.md) for GitHub configuration and limits. Older product-repair documents describe historical work, not current production acceptance.

Current deployment and actual production run evidence: [18 November live verification](LIVE_VERIFICATION_2026-11-18.md).
