# Connect a coding agent

## Local MCP

Run `npx traceyard mcp` to give an agent six local tools—`reproduce`, `check`, `verify`, `guard`, `explain`, and `inspect`—on the same machine as the repository. The local server uses stdio, does not require a TraceYard account, and does not upload local edits. Setup examples for Claude Code, Cursor, Copilot, and Codex are in the [CLI guide](CLI.md#coding-agents-mcp).

`reproduce`, `check`, and `verify` responses include a compact `claim` with the evidence `state`, `claim`, `scope`, `source`, and `commit` (plus a short `worktree` fingerprint for `check`), and any run-specific `limitations`. When a response is shortened to fit `outputChars`, the claim is never removed; only its limitations shrink, down to one. Local claims are always `LOCAL_PROVISIONAL` and `FOCUSED`. The full envelope is available from `traceyard <command> --json` and in the receipt.

## Hosted MCP

The hosted server is available at `https://traceyard.pilotsaviour229.workers.dev/mcp` using Streamable HTTP with OAuth. In the hosted TraceYard UI, open **Agents** at `/agents` and choose the client setup instructions. **Agents** is the current workspace page; “connection” may describe OAuth state, but it is not the current navigation label.

Hosted MCP exposes a different tool set from local MCP:

| Server                | Tools                                                         | Access and inputs                                                                            |
| --------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Local `traceyard mcp` | `reproduce`, `check`, `verify`, `guard`, `explain`, `inspect` | Local repository path; no account or project authorization.                                  |
| Hosted `/mcp`         | `investigate`, `inspect`, `verify`                            | OAuth, an approved repository/project, pushed commits, and hosted investigation identifiers. |

### Authorization and project selection

1. Add the hosted server to your MCP client and complete GitHub sign-in in the browser.
2. Call `inspect` with `section: "capabilities"` first. If the response is `PROJECT_ACCESS_REQUIRED`, open the supplied browser URL and approve access to the intended repository/project. If the response is `PROJECT_SELECTION_REQUIRED`, pass the returned `projectId` or select the requested project in the client.
3. Use `investigate`, `inspect`, and `verify` only after authorization. Hosted execution checks pushed commits; local uncommitted edits are not uploaded.

A concrete hosted flow is:

```text
investigate({ mode: "execute", testPath: "tests/checkout-retry.test.ts", commit: "<40-character-failing-sha>", projectId: "<approved-project-id>" })
inspect({ section: "evidence", investigationId: "<investigation-id>", evidenceId: "<evidence-id>" })
verify({ investigationId: "<investigation-id>", commit: "<40-character-candidate-sha>" })
```

For an exact Pytest run, include `mode: "execute"`, `testPath`, the failing full SHA, and a `testCase` such as `TestCheckout::test_total[wallet]`. The selector excludes the file path. [Python package setup](CI_TEST_EVIDENCE.md#rerun-a-pytest-failure).

After `verify`, poll hosted `inspect` with `section: "verification"` and the verification ID. The result references both evidence sets. Hosted `investigate`/`verify` apply to the recorded test and conditions, not to application-wide correctness.

In Antigravity, copy the setup request from the **Agents** page, or add the MCP URL as `serverUrl` in the existing `mcpServers` configuration. Open **Customizations → Installed → MCP Servers** and select **Authenticate**.

Hosted project approvals are account-wide for the agent, while each approval controls which repository it can access. Use the Agents access controls to remove an approval or disconnect the agent. POST requests return tool results; authenticated GET requests open a server-sent event stream with a heartbeat every 15 seconds.

[Repository setup](REPOSITORY_SETUP.md) · [Interaction replay](REPLAY.md) · [Changelog](../CHANGELOG.md)
