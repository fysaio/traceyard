# TraceYard product coherence outcomes

## Workspace and MCP access

TraceYard must keep the selected repository visible while a user connects or manages an agent. The Agents page must explain the endpoint, client setup, repository scope, capabilities, current connection state, and the consequence of revoke/disconnect without sending the user to an unrelated raw-looking surface. OAuth connection management must stop emitting `/projects` links and must distinguish a repository from a default/project record.

## Repository selection and status

Repository rows must identify the repository clearly, keep long names clear of the search icon, and distinguish no repositories from no search matches. Status language must say whether it describes the latest completed check, an in-progress operation, setup/discovery, or no checks yet.

## Checks and investigations

A check timeline must explain the relationship between supported-entry-point discovery and a manually selected test. Failed checks must lead to a TraceYard-native next step where the available check context supports one, while raw provider logs remain a secondary technical detail. Investigation blocked states and retained evidence must lead with a human-readable explanation before raw JSON/code.

## Landing and responsive quality

The landing page must tell a concise Connect → Reproduce → Verify story while preserving the existing Before/After interaction, monochrome visual language, restrained status accents, reduced-motion behavior, and clear open-source positioning. Authenticated surfaces must remain usable with keyboard navigation, narrow screens, long repository names, async failures, and modal focus transitions.

## Validation and delivery

Implementation must be validated with typecheck, lint, focused unit/acceptance coverage for search, repository status, OAuth transitions, check/investigation continuity, modal keyboard behavior, and landing interactions, followed by the broader build/test suite. Do not deploy or commit until the validated result and delivery decision are explicit.
