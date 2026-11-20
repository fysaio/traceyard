# TraceYard product coherence implementation plan

## Direction

Make TraceYard feel like one product by keeping repository context, permission scope, execution state, and evidence hierarchy consistent across the public landing page and authenticated workspace. Preserve the monochrome technical aesthetic and current useful interactions; improve clarity, progressive disclosure, feedback, and recovery before adding decoration.

## Project structure

The React product surface lives in `src/`. `src/components/` owns shared UI primitives and the public landing surface, `src/pages/` owns repository, agent, check, and investigation flows, `src/lib/` owns workspace and API clients, and `src/styles/app.css` is the shared design system and responsive layer. The Cloudflare Worker lives in `worker/`; API route modules own authenticated workspace behavior, repository modules own discovery and check execution, service modules own investigations, and `worker/mcp/` owns OAuth and MCP protocol behavior. Shared contracts remain in `shared/`. Unit, integration, browser, and acceptance coverage live under `tests/`. Product planning and outcome tracking stay in `plan.md` and `TODO.md`.

## Design direction

The chosen direction is **quiet technical editorial**: a monochrome workspace with a paper-like surface, compact evidence-led layout, and semantic green/red/blue accents only for state. Its principles are contextual clarity, progressive disclosure, and calm recovery. Layouts use deliberate vertical rhythm and content-width constraints rather than dense dashboard grids. Interaction feedback is short and purposeful; motion supports state changes and respects reduced-motion preferences. Typography keeps Instrument Sans for interface hierarchy and system monospace for commits, endpoints, and raw executor output.

The brand voice is direct, evidence-led, and reassuring without pretending certainty. Example lines are “Find what broke. Prove it’s fixed.” and “Human-readable findings come first; open the evidence when you need the exact output.” TraceYard is positioned as an open-source way for developers and coding agents to reproduce a failure at its real commit and verify the fix with retained evidence.

## Phase 1 — coherence and trust foundations

- Replace the disconnected Agents/MCP access link with in-workspace scoped access management.
- Rewrite MCP onboarding around server identity, repository scope, capabilities, authorization, and a human-readable success state.
- Remove legacy `/projects` links from current UI copy and server-rendered connection pages.
- Add explicit repository identity and latest-check metadata to repository rows.
- Add context-aware check status copy when discovery and execution disagree.
- Fix search-field spacing with a deployment-safe selector and add long-value regression coverage.

## Phase 2 — evidence and first-success flow

- Make failed checks explain whether they were blocked, manually executed, or actually failed.
- Add a TraceYard-native route from failed checks to investigation where the available data supports it.
- Make investigation setup prefer discovered tests and CI context, keeping manual path/SHA as an advanced fallback.
- Turn GitHub setup into an explicit persistent state model visible after closing the modal.
- Put human-readable verdicts before raw technical evidence, with copy/full-view affordances.

## Phase 3 — landing and responsive product surface

- Expand the public landing story to Connect → Reproduce → Verify while preserving the Before/After interaction.
- Clarify browser versus MCP usage and open-source/self-hosting value.
- Validate authenticated desktop, tablet, mobile, keyboard, zoom, reduced-motion, dark-mode, and failure states.

## Design guardrails

- No decorative SVG wall, gradients, or generic SaaS dashboard.
- Keep status accents semantic and restrained.
- Use one primary action per state.
- Every async state says what is happening, why it matters, and what happens next.
- Every permission action names the agent, repository/project, capability, and consequence.
- Do not claim behavior the backend does not support; add API support before adding UI promises.

## First implementation batch

This batch targets the highest-confidence, cross-cutting issues without changing backend execution semantics: workspace navigation language, scoped MCP onboarding and access section, repository list context, failed-check explanation, search CSS specificity, and landing-page explanatory copy/story.
