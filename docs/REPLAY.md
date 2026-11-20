# Vitest interaction replay (retained JSON fetches)

For a standalone comparison of static browser builds, see [browser journey replay](BROWSER_JOURNEYS.md).

## How to use it

Interaction replay starts from a hosted Investigations execution or the hosted MCP API. Run an eligible Vitest test with `investigate` using `mode: "execute"` and `captureInteractions: true`:

```text
investigate({
  mode: "execute",
  testPath: "tests/cart.test.ts",
  commit: "<40-character-failing-sha>",
  captureInteractions: true,
  projectId: "<approved-project-id>"
})
```

When the test makes eligible JSON `globalThis.fetch` calls, the result contains a `recordingId` such as `rcd_...`. Read its bounded manifest with `inspect({ section: "recording", investigationId: "<id>", recordingId: "<recording-id>" })`. To replay the same test against the retained responses, use `investigate({ mode: "replay", recordingId: "<recording-id>" })`; to compare a repair, use hosted `verify` with the investigation ID and a full candidate SHA. The browser Investigations UI exposes the same recording references.

Capture is opt-in because application bodies may contain private business data. An execution records up to eight JSON fetch request/response bodies and statuses. Headers, credential environment values, credential-bearing bodies, and oversized/non-JSON responses are not retained. Any omitted interaction makes the recording ineligible. A recording is immutable and bound to the authorized attempt, source revision, test, and repository/project.

## Isolation and limits

Replay requires a Linux executor with Docker. TraceYard prepares a small trusted Node image, filters environment/configuration files out of a disposable source copy, mounts that copy read-only, drops capabilities, and runs with `--network none`, no application secrets, and a bounded writable temporary filesystem. Placeholder credentials satisfy application configuration checks; real credentials are not forwarded. Test writes affect only the disposable workspace. Image preparation may require an initial public Node image download; test execution has no network access. Missing Docker, an unmatched request, request-count drift, native network use, unsupported output, or timeout blocks replay. There is no live fallback.

This adapter models JSON fetch bodies and status codes. Response-header-dependent behavior, streaming, native tools, databases, browser requests, and other network clients are outside its supported boundary. A passing selected test establishes that test's assertions against retained responses, not application-wide correctness or production recovery. Changed tests and omitted regression files remain visible during verification. Docker is the isolation boundary; monkey-patching fetch alone is not isolation.

## Recovery is a different capability

`recover` applies to TraceYard-owned workflow executions with retained step checkpoints. Resume can reuse completed steps; restart may repeat external actions. An imported trace, log, or JSON recording does not make arbitrary application code resumable.

## Validation

`npm test` includes HTTP capture and adapter replay, credential omission, changed-request rejection, migrated D1 ownership, immutable storage, and replay proof requirements. `node scripts/verify-isolated-replay.mjs` is the Docker acceptance check in CI; it captures one response, reproduces a failing test, verifies a repair, rejects divergence, checks host-write isolation, and asserts one total live request. It deliberately fails if Docker isolation is unavailable.
