# Connect a coding agent

Open **Connections** in Traceyard and choose your client. For the hosted app, the remote MCP URL is `https://traceyard.pilotsaviour229.workers.dev/mcp`. Use Streamable HTTP with OAuth.

1. Add Traceyard to your MCP client and complete GitHub sign-in in the browser.
2. Ask the agent to inspect your repository. If it needs project access, open the link it returns and choose **Allow access**. Connect the repository in Traceyard if it is missing.
3. Ask a concrete question, such as “Run the checkout retry test and show me why it failed.” Follow the returned browser link to see the same evidence.

In Antigravity, copy the setup request from Traceyard’s **Connections** page, or add the MCP URL as `serverUrl` in your existing `mcpServers` configuration. Open **Customizations → Installed → MCP Servers** and select **Authenticate**.

## Tools

| Tool          | Use                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------- |
| `investigate` | Read indexed source or run an existing Vitest or Jest test in the configured repository. |
| `inspect`     | Read findings, exact-revision source, evidence, or a verification result.                |
| `verify`      | Rerun a saved failing test at a candidate commit and report changes to its test files.   |
| `recover`     | Resume or restart an owned Traceyard workflow with the recovery scope.                   |

Connections are account-wide. Each project approval controls which repository the agent can access. Use **Manage agent access** to remove a project approval or disconnect the agent. For multiple approved projects, pass `projectId` when the client exposes it.

POST requests return tool results. Authenticated GET opens a server-sent event stream with a heartbeat every 15 seconds. This accommodates clients that keep a listening connection open.

[Repository setup](REPOSITORY_SETUP.md) · [Interaction replay](REPLAY.md) · [Changelog](../CHANGELOG.md)
