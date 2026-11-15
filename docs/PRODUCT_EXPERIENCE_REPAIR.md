# Product experience repair — 2026-11-15

## Why this repair exists

PR #1 reached GitHub and was merged at a9f9d4bb281413c1cd30ab4c7e664c4131340814. It had a real backend but a reduced React interface. It did not preserve the workflow library, project/account menus and creation paths developed in the Traceyard.html prototype. Passing backend checks was insufficient evidence that the agreed product experience had shipped.

This repair recovered the current Traceyard.html reference (Library version 3) and restored its main product structure in the connected React app. The public static prototype is separate and unchanged. The repository is the implementation to pull; the prototype is not a deployed Worker.

## Implemented

- Main navigation: Workflows, Executions, Gateway, Laboratory; search, project switcher and account menu.
- Actual project listing, creation, rename, reload selection and owned-project isolation. Project context travels in internal links. New accounts receive a Main project; existing project names are preserved.
- One workflow library for Studio drafts/published definitions, My workflows/Templates, functional list/grid preference, real icon selection, create choices, duplicate/export/archive and version history.
- Eight engine-backed editable templates. Model/HTTP templates require real routes/connections before publication. Research uses supplied source notes; there is no invented web-search result or specialized CRM adapter.
- Studio add-step picker, connection ports, pan/zoom/fit/layout, undo/redo, metadata/icon configuration and Run published version. Incomplete JSON remains visible and blocks save/publish, including after selecting another node.
- Application connection setup: project → trace-scoped server key → TypeScript or direct HTTP example → first received span → trace inspection. A key alone does not mark the project connected. Observed workflow spans are listed with their service and last trace; they are not launchable Studio definitions.
- Eligible anonymous executions can be claimed into a selected owned project after sign-in.
- Parse JSON and allowlisted HTTP Tool nodes, optional encrypted HTTP bearer credentials, captured URL/method at launch/retry, actual HTTP evidence in the trace. External effects remain at least once; receivers must deduplicate the stable idempotency key.
- Settings sections for account/sessions, projects, appearance, HTTP connections, API keys/SDK and schedules/webhooks. Appearance restores before first render.
- Fixed horizontal overflow from the visually hidden workflow import input. Shared rounded controls, modal focus restoration and responsive layout rules.

Import accepts the versioned executable JSON exported by this application. The older prototype's raw workflow object format is not converted. GitHub sign-in authenticates identity; it does not enumerate or import GitHub repositories.

## Actual browser evidence

The normal local Worker preview completed a real anonymous launch with retained execution/trace data:

- run_262cd82adb1a42009cff11d73aa7344f — document pipeline, SUCCEEDED, 149 ms. Opened the Extract insights step's input/output and verified history retained the run.

The isolated acceptance configuration then created a real local user/session against a separate D1 database, without claiming to test GitHub OAuth:

1. Created Browser acceptance project in the UI; it appeared in the project switcher.
2. Opened Templates → Parallel processing → Use template. Draft wf_024a22fe330b4db8b06927cb346ac39d was persisted.
3. Used Fit graph, published v1 and opened Run v1 from Studio.
4. Submitted `{"customer":{"name":"Browser QA"},"order":{"id":"order-001"}}`.
5. run_e1e13592357646ac8969f0ba1e648a09 completed SUCCEEDED in 90 ms, with 5/5 steps and retained output `[{"name":"Browser QA"},{"id":"order-001"}]`.
6. Returned to Workflows, toggled grid, reloaded and verified project selection persisted.
7. Switched to Main project and verified that the other project's workflow was absent. Project settings showed the separate 0/0 and 1 workflow/1 execution counts.
8. Checked the project menu, workflow creation choices and visible application connection steps.
9. Before a later browser-control timeout, DOM measurements confirmed document scrollWidth equalled clientWidth after the import-input overflow fix. Compact navigation and connection/workflow headings were subsequently inspected with browser zoom at 200% and 300%; this is responsive/zoom evidence, not physical-phone or touch verification.

The browser-control API later timed out enabling focus emulation; native screenshot/input continued to work. Browser DevTools was unavailable by organization policy, so no device emulation was bypassed. The separate server-to-preview SDK connection could not be run from the command executor's network namespace. The first-span/observed-list behavior is instead covered by actual Worker API integration tests, with synthetic spans sent through the authorized endpoint.

## Automated validation

68 unit tests and 84 Worker integration tests pass, using actual local D1, Queue and Workflow bindings. New coverage includes project rename/isolation, first-span connection detection, observed workflow listing, every template's creation and validation requirements, real parallel graph execution, encrypted HTTP metadata/snapshot/adapter evidence, selected-project sandbox claim, and JSON parse failures. External GitHub/provider/HTTP services use explicit test doubles where needed.

TypeScript, production build, ESLint and git diff checks pass. The production build reports a client chunk over 500 KB; code splitting remains a performance improvement, not a failed build. Browser contract tests were updated but not run through the Playwright CLI in this environment; do not count them as passed.

## Configuration and remaining acceptance

Migration 0007 is additive. Normal dev applies local migrations before starting. Vite disables the optional Worker debugger to avoid host-interface discovery failure. Acceptance mode uses tests/browser/fixture-worker.ts and a separate local DB/config; its account route is not imported by production. Never deploy wrangler.acceptance.jsonc.

Still required before a release-readiness claim:

- Live configured GitHub sign-in and cross-device session verification.
- Live provider and fallback calls, external application instrumentation, allowed HTTP receiver and signed webhook/cron deployment checks.
- Complete all-screen keyboard and visual acceptance, real phone/touch gestures and mobile Studio interaction.
- Production resource/secrets review, remote migrations and deployment.

No production credentials were added, no remote migrations were applied and no deployment occurred. AntiGravity should pull the repair branch for these remaining local/configured checks; it should not rebuild the frontend.
