# Local acceptance and merge gate

Use this branch as the implementation. Do not rebuild the frontend in a separate tool. Record actual results for these checks; a checkbox below is a task, not a claim that it passed.

## Prepare

1. Pull `integration/real-auth-workflows` from the repository or check out PR #1.
2. Install Node ≥22.12, run `npm ci`, then `npm run db:migrate:local`.
3. Configure the ignored `.dev.vars` values described in README. Register the matching GitHub OAuth callback. Generate your own 32-byte base64 integration encryption master key; never commit it.
4. Run `npm test`, `npm run lint`, `npm run build`, then `npm run dev`.
5. Enter one real provider credential in Gateway. Use the exact supported model identifier from your provider account. Workers AI also needs the Cloudflare account ID. Configure only intended HTTPS webhook hosts.

## Walk the product

- Sign in through GitHub, reload, create another project, switch projects, sign out and sign in again. Verify other account/project records remain inaccessible.
- Create a workflow. Connect Input → Pick → Output, configure a field path, save, reload, publish and run with actual JSON. Inspect the returned field, attempt input/output and event history. Export execution JSON.
- Export its Studio workflow JSON. Import the file from Workflows. Confirm the imported copy is an unpublished draft. Unknown file/schema formats must produce an error. Model route IDs are project-local references and must be reassigned when importing into another project.
- Create a Condition with true and false targets, rejoin through Merge, publish and run both inputs. Confirm the unused branch is skipped. Run a bounded Map with valid and excessive array lengths; inspect the real failure.
- Create a Gateway route with a configured provider/model. Send a prompt; verify the returned text, actual token usage (or unavailable), measured duration and request history. If rates are entered, compare the estimate against token counts. Test missing credentials and a rejected provider request.
- Add a Model step to a published graph and run it. Change the saved route afterward and verify the accepted execution retains its captured route configuration. Retry a failed execution and inspect its version/snapshot.
- Add an Approval step. Start a run, open Approvals and approve it. Verify output and continuation. Separately reject, expire and cancel waiting runs; they must stop rather than execute downstream steps. A second or late decision must fail.
- Create an experiment with 2 trials and an output assertion. Run it and inspect both execution links. Repeat the launch request; the same trials must remain linked. Test a deliberately wrong expectation; it must fail. Compare actual results.
- Create an API key with trace/write permission only. Send nested spans using `sdk/client.ts`, inspect hierarchy/redaction, then revoke the key and verify rejection. Try HTTP launch with a trace-only key: it must fail. Test CLI launch/inspect with a suitably scoped key.
- Schedule a published version with valid input. Wait for the actual five-minute cron; inspect the linked run. Pause it and confirm later invocations do not launch. Invalid/deleted configuration must expose a schedule error.
- Point a webhook at your allowlisted receiver. Verify timestamp/body HMAC and stable delivery ID. Return a failure and inspect retry evidence; then accept a retry. Disallowed destinations and redirects must fail. Delivery is at least once, so receivers must deduplicate.

## Presentation

Use every reachable screen at 390, 768, 1009 and 1440 CSS pixels. Check navigation, controls inside cards, list/grid difference, form bounds, long IDs/code, Gateway routes, provider errors, approval payloads and comparison columns. Use keyboard focus/activation, a touch device, native pinch/scroll, Studio drag/keyboard movement and zoom controls. Respect reduced-motion preferences. Verify browser Back/Forward and reload on detail URLs.

Run the browser tests on a working runtime. Existing UI contract tests intentionally stub some responses and do not replace these authenticated journeys. The current ChatGPT workspace cannot complete interactive preview because the Cloudflare Vite plugin fails with `uv_interface_addresses`; this remains a verification gap, not a passed test.

## Before production

Confirm intended Cloudflare account/resource IDs, GitHub production callback, encryption secret, provider credentials, allowed outbound hosts and reviewed migrations. Deploy on a single origin and repeat a real sign-in, execution, approval, trace and provider request. Keep the PR unmerged until the agreed verification is complete.
