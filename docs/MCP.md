# Coding-agent connection

Add `https://YOUR_TRACEYARD_HOST/mcp` as a remote MCP server in a client that supports Streamable HTTP and OAuth browser authorization. Sign in with the existing GitHub account, select a project and approve the displayed scopes. No Traceyard server key or application provider key is pasted into the client.

The endpoint uses the same investigations and evidence as the browser APIs. It is enabled only after the application revision and migrations through `0022_investigation_retention.sql` are deployed. Targeted execution additionally requires the compatible reviewed runner; installing MCP does not attach to an already-deployed application process.

## Antigravity

In Traceyard Connections, expand **Connect with Antigravity**, copy the setup request and paste it into an Antigravity chat. Review the configuration update, which asks the agent to preserve existing servers. Antigravity manages local MCP configuration and authorization; Traceyard cannot silently edit those settings from its web page.

For manual configuration, add an entry named `traceyard` with `serverUrl` set to the deployed `/mcp` endpoint inside the existing `mcpServers` object. Antigravity's configuration is `~/.gemini/config/mcp_config.json` (under `%USERPROFILE%` on Windows). Then use **Customizations → Installed → MCP Servers → Authenticate**. Choose the Traceyard project whose investigations this agent should access. The selector lists existing Traceyard projects, not an additional GitHub repository grant. Finish any authorization-code step inside Antigravity. An Unauthorized status before completing this flow does not establish a transport failure.

See [Antigravity's MCP documentation](https://antigravity.google/docs/mcp?tab=ide). Its remote Streamable HTTP and dynamic client registration match the supported Traceyard flow. Successful integration tests do not prove that a particular installed Antigravity version has connected.

## Browser consent

The authorization document uses `Referrer-Policy: same-origin`: a native form under `no-referrer` otherwise submits `Origin: null`, which the cross-origin guard correctly rejects. Other responses, including the callback redirect, retain `no-referrer`. The consent document permits its validated, registered callback origin in CSP `form-action`, because Chromium applies that directive to the form's redirect too. Global form destinations stay restricted to self, and null/untrusted Origins remain rejected.

No project is selected silently. Approval requires an owned project; cancellation requires no selection and creates no grant. Authorization errors render a recovery page with an instruction to restart authentication in the coding client. Browser acceptance exercises actual native form submission, explicit selection, a different-origin callback, PKCE token exchange, official SDK tool discovery and a project-bound investigation. Separate integration checks reject null/foreign Origins and another owner's project.

## Tools

| Tool          | Use                                                                                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `investigate` | Read indexed source or existing failure evidence. `mode: execute` requests a focused existing Vitest test; ambiguous matches return candidate paths. Optional JSON capture enables `mode: replay` with an eligible recording reference. |
| `inspect`     | Read a finding, status, evidence range, exact-revision source excerpt, verification, recording manifests or recent investigations.                                                                                                      |
| `verify`      | Run a retained failed reproducer against a candidate commit, with bounded related regressions and changed-test disclosure.                                                                                                              |
| `recover`     | Resume/restart an owned failed Traceyard workflow when the connection grants `runs:recover`. Observation of arbitrary code is not a continuation checkpoint.                                                                            |

Start with a question such as “Use Traceyard to investigate the failing Today proposal test.” The coding agent should request relevant evidence, edit through its existing repository tools and verify the candidate. Tests execute in the configured repository environment, not in the MCP transport process.

Results use durable investigation IDs. The `browserUrl` opens the same record. `outputChars` bounds the brief; `omitted` signals details available through `inspect`. Evidence ranges include `nextOffset`. Polling status returns a small result and a suggested interval, rather than repeating full artifacts.

Default authorization permits investigation reads and supported execution. Real workflow recovery is a separate requested scope. Grants are project-bound, revocable, and use expiring access tokens and rotating refresh tokens. Browser sign-out does not silently revoke an intentionally persistent agent connection; revoke it under project agent connections.

## Compatibility and evidence

The implementation uses official MCP TypeScript SDK `1.32.2` and its web-standard stateless HTTP transport. Local integration tests exercise the official client SDK's authorization discovery, dynamic registration, PKCE exchange, protocol negotiation, tool discovery, invocation, reconnect and revocation. This does not establish compatibility with every coding-agent product or a live deployed OAuth provider.

No general token-savings percentage is claimed. Structured evidence avoids unbounded log output; measured provider usage and client token accounting remain separate from character budgets.

## Operator notes

The existing public origin and GitHub sign-in configuration are reused. MCP client authorization is separate from GitHub repository installation access. Route `/mcp`, `/oauth/*` and `/.well-known/*` to the Worker rather than the SPA asset fallback. Discovery metadata is public; tools require a scoped token. Repository source, logs and model responses are untrusted data, not tool instructions.

See [deployment and acceptance](INVESTIGATION_RELEASE.md) for the complete release gate and [the measured fixture](benchmarks/investigation-fixture.json) for evidence-size accounting.
