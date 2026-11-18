# Investigation product implementation

The product outcome is an existing-code investigation that a coding agent can start through MCP, inspect economically, and verify after a repair. The browser opens the same record. Existing graph execution and recovery remain available.

User authorization: implement each step on its own branch/PR, review and test it, then merge correct changes and continue. Do not modify connected applications as a setup requirement. Do not claim missing runtime capabilities or unmeasured savings.

| Step | Branch                              | Deliverable                                                                                | Required evidence                                                               | Status                                                                                    |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 0    | fix/repository-connection-flow      | Existing execution/recovery foundation                                                     | 319 tests, build/lint, hosted CI                                                | Merged PR #6                                                                              |
| 1    | feat/investigations-01-foundation   | Durable shared investigations, bounded evidence, ownership and immutable snapshots         | Real migrated D1 API tests, isolation and request deduplication                 | Merged PR #7; 324 tests, build/lint pass                                                  |
| 2    | feat/investigations-02-discovery    | Package/workspace/test discovery and source relationships                                  | Fixture repositories, import/test discovery and explicit coverage               | Merged PR #8; 329 tests, build/lint pass                                                  |
| 3    | feat/investigations-03-execution    | Targeted execution, structured failure artifacts and durable investigation linkage         | Actual fixture processes, bounded reporting and interruption handling           | Merged PR #9; 335 tests/build/lint pass                                                   |
| 4    | feat/investigations-04-verification | Baseline/candidate verification, compatible reuse and cost accounting                      | Reproduce failure, verify repair, preserve original and changed-test disclosure | Merged PR #10; 338 tests/build/lint pass                                                  |
| 5    | feat/investigations-05-mcp          | Hosted authenticated MCP and bounded investigation tools                                   | Protocol client, authorization/revocation, project isolation and reconnect      | Merged PR #11; 343 tests, SDK OAuth/protocol/reconnect pass                               |
| 6    | feat/investigations-06-replay       | Supported isolated interaction recording/replay and honest recovery capabilities           | No-network replay, divergence refusal, checkpoint provenance                    | Merged PR #12; real isolated replay CI passed                                             |
| 7    | feat/investigations-07-web          | Investigation-first browser and unified connection status                                  | Fresh/returning journeys, errors, deep links and responsive interaction         | Merged PR #13; browser, replay and build CI passed                                       |
| 8    | feat/investigations-08-acceptance   | Agent/browser end-to-end validation, reproducible cost benchmark, deployment documentation | Actual supported client journey, baseline comparison, exact deployment evidence | Merged PR #14; deployed `7cf9c40` after fixes #15–16; live focused test passed; live agent OAuth, repair verification and replay remain open |

## Production acceptance checkpoint — 18 November 2026

The operator deployed migrations through 0022 and the reviewed runner. GitHub sign-in, repository connection, source analysis and a real inferred focused test succeeded in the deployed app. The result retained seven passing assertions at the investigation's exact source revision. PR #17 enabled the reviewed repository workflow with explicit operator approval; PR #18 corrected four observed UI issues and awaits the next deployment. The complete suite now contains 352 tests, with Linux and Windows release gates covering synthetic operator environment files.

See [the live acceptance record](LIVE_INVESTIGATION_ACCEPTANCE_2026-11-18.md) for the deployment, investigation and GitHub run references. Step 8 is not fully accepted until an external coding client authorizes MCP, uses the same investigation/evidence, verifies a retained failing reproducer against a candidate and exercises eligible isolated replay. Existing controlled CI evidence remains distinct from those pending live checks.

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
