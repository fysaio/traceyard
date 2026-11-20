# Connect a coding agent

**Local, no account:** run `traceyard mcp` to give your agent `reproduce`, `check`, `verify`, `guard`, `explain` and `inspect` on your own machine. Setup for Claude Code, Cursor, Copilot and Codex is in the [CLI guide](CLI.md#coding-agents-mcp). The rest of this page covers the hosted server.

Open **Connections** in Traceyard and choose your client. For the hosted app, the remote MCP URL is `https://traceyard.pilotsaviour229.workers.dev/mcp`. Use Streamable HTTP with OAuth.

1. Add Traceyard to your MCP client and complete GitHub sign-in in the browser.
2. Ask the agent to inspect your repository. If it needs project access, open the link it returns and choose **Allow access**. Connect the repository in Traceyard if it is missing.
3. Ask for a particular check, such as “Run `tests/checkout-retry.test.ts` at the failing commit and show me the assertion and output.” Follow the returned browser link to see the same evidence.

To reproduce a known failure, give the agent the test file and the exact failing commit. Ask it to inspect the retained assertion and output. Once your candidate is pushed, use `verify` with the same investigation ID and the full candidate SHA. Poll `inspect` with `section: "verification"` and the verification ID. The result includes references to both sets of evidence. Use `inspect` with `section: "evidence"`, the corresponding investigation ID, and an evidence ID to read the retained report. The verification applies to the recorded test and conditions.

In Antigravity, copy the setup request from Traceyard’s **Connections** page, or add the MCP URL as `serverUrl` in your existing `mcpServers` configuration. Open **Customizations → Installed → MCP Servers** and select **Authenticate**.

## Tools

| Tool          | Use                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `investigate` | Read indexed source or run an existing Vitest, Jest, or Pytest test in the configured repository. |
| `inspect`     | Read findings, exact-revision source, evidence, or a verification result.                         |
| `verify`      | Rerun a saved failing test at a candidate commit and report changes to its test files.            |
| `recover`     | Resume or restart an owned Traceyard workflow with the recovery scope.                            |

For an exact Pytest run use `mode: execute`, `testPath`, the failing `commit`, and a `testCase` such as `TestCheckout::test_total[wallet]`. The selector excludes the file path. [Python package setup](CI_TEST_EVIDENCE.md#rerun-a-pytest-failure).

Connections are account-wide. Each project approval controls which repository the agent can access. Use **Manage agent access** to remove a project approval or disconnect the agent. For multiple approved projects, pass `projectId` when the client exposes it.

POST requests return tool results. Authenticated GET opens a server-sent event stream with a heartbeat every 15 seconds. This accommodates clients that keep a listening connection open.

[Repository setup](REPOSITORY_SETUP.md) · [Interaction replay](REPLAY.md) · [Changelog](../CHANGELOG.md)
