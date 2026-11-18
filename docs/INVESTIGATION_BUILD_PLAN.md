# Investigation product implementation

The product outcome is an existing-code investigation that a coding agent can start through MCP, inspect economically, and verify after a repair. The browser opens the same record. Existing graph execution and recovery remain available.

User authorization: implement each step on its own branch/PR, review and test it, then merge correct changes and continue. Do not modify connected applications as a setup requirement. Do not claim missing runtime capabilities or unmeasured savings.

| Step | Branch                              | Deliverable                                                                                | Required evidence                                                               | Status                                   |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------- |
| 0    | fix/repository-connection-flow      | Existing execution/recovery foundation                                                     | 319 tests, build/lint, hosted CI                                                | Merged PR #6                             |
| 1    | feat/investigations-01-foundation   | Durable shared investigations, bounded evidence, ownership and immutable snapshots         | Real migrated D1 API tests, isolation and request deduplication                 | Merged PR #7; 324 tests, build/lint pass |
| 2    | feat/investigations-02-discovery    | Package/workspace/test discovery and source relationships                                  | Fixture repositories, import/test discovery and explicit coverage               | Merged PR #8; 329 tests, build/lint pass |
| 3    | feat/investigations-03-execution    | Targeted execution, structured failure artifacts and durable investigation linkage         | Actual fixture processes, bounded reporting and interruption handling           | Merged PR #9; 335 tests/build/lint pass  |
| 4    | feat/investigations-04-verification | Baseline/candidate verification, compatible reuse and cost accounting                      | Reproduce failure, verify repair, preserve original and changed-test disclosure | Implemented; 338 tests/build/lint pass   |
| 5    | feat/investigations-05-mcp          | Hosted authenticated MCP and bounded investigation tools                                   | Protocol client, authorization/revocation, project isolation and reconnect      | Pending                                  |
| 6    | feat/investigations-06-replay       | Supported isolated interaction recording/replay and honest recovery capabilities           | No-network replay, divergence refusal, checkpoint provenance                    | Pending                                  |
| 7    | feat/investigations-07-web          | Investigation-first browser and unified connection status                                  | Fresh/returning journeys, errors, deep links and responsive interaction         | Pending                                  |
| 8    | feat/investigations-08-acceptance   | Agent/browser end-to-end validation, reproducible cost benchmark, deployment documentation | Actual supported client journey, baseline comparison, exact deployment evidence | Pending                                  |

## Dependency review

- Store evidence and source identity before adding another transport.
- Discover existing tests before choosing commands; permit only bounded supported plans.
- Produce structured failure evidence before promising a useful MCP result.
- Verification identifies the candidate actually executed, including changed tests.
- MCP and browser invoke the same authorized services and share durable IDs.
- Replay and real recovery remain separate operations with explicit capability checks.
- Repository access, execution setup and deployed-runtime attachment are distinct connections.
- Default analysis and summarization use deterministic code, not an additional paid model.
- Full artifacts remain behind references; bounded summaries disclose omissions.
- Source inference never becomes claimed runtime evidence; absence of traces never becomes a successful observed operation.

Review this checklist with every PR. Update status, PR links, validation and material limitations as work proceeds. A merged PR does not establish production deployment. Stop dependent actions only for a concrete unavailable capability or required external authorization; complete independent work first.
