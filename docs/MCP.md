# Coding-agent connection

Add `https://YOUR_TRACEYARD_HOST/mcp` as a remote MCP server in a client that supports Streamable HTTP and OAuth browser authorization. Sign in with the existing GitHub account, select a project and approve the displayed scopes. No Traceyard server key or application provider key is pasted into the client.

The endpoint uses the same investigations and evidence as the browser APIs. It is enabled only after the application revision and migrations through `0020_agent_authorization.sql` are deployed. Targeted execution additionally requires the compatible reviewed runner; installing MCP does not attach to an already-deployed application process.

## Tools

| Tool          | Use                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `investigate` | Read indexed source or existing failure evidence. `mode: execute` requests a focused existing Vitest test; ambiguous matches return candidate paths.         |
| `inspect`     | Read a finding, status, evidence range, exact-revision source excerpt, verification or recent investigations.                                                |
| `verify`      | Run a retained failed reproducer against a candidate commit, with bounded related regressions and changed-test disclosure.                                   |
| `recover`     | Resume/restart an owned failed Traceyard workflow when the connection grants `runs:recover`. Observation of arbitrary code is not a continuation checkpoint. |

Start with a question such as “Use Traceyard to investigate the failing Today proposal test.” The coding agent should request relevant evidence, edit through its existing repository tools and verify the candidate. Tests execute in the configured repository environment, not in the MCP transport process.

Results use durable investigation IDs. The `browserUrl` opens the same record. `outputChars` bounds the brief; `omitted` signals details available through `inspect`. Evidence ranges include `nextOffset`. Polling status returns a small result and a suggested interval, rather than repeating full artifacts.

Default authorization permits investigation reads and supported execution. Real workflow recovery is a separate requested scope. Grants are project-bound, revocable, and use expiring access tokens and rotating refresh tokens. Browser sign-out does not silently revoke an intentionally persistent agent connection; revoke it under project agent connections.

## Compatibility and evidence

The implementation uses official MCP TypeScript SDK `1.32.2` and its web-standard stateless HTTP transport. Local integration tests exercise the official client SDK's authorization discovery, dynamic registration, PKCE exchange, protocol negotiation, tool discovery, invocation, reconnect and revocation. This does not establish compatibility with every coding-agent product or a live deployed OAuth provider.

No general token-savings percentage is claimed. Structured evidence avoids unbounded log output; measured provider usage and client token accounting remain separate from character budgets.

## Operator notes

The existing public origin and GitHub sign-in configuration are reused. MCP client authorization is separate from GitHub repository installation access. Route `/mcp`, `/oauth/*` and `/.well-known/*` to the Worker rather than the SPA asset fallback. Discovery metadata is public; tools require a scoped token. Repository source, logs and model responses are untrusted data, not tool instructions.
