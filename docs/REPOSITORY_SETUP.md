# Repository discovery and project checks

This adds the first repository-first path. The main Project screen combines source discoveries, actual application executions and build/test checks. The former Executions URL uses the same project activity view, so external Somni traces no longer disappear behind zero managed-engine runs. Build retains the optional Traceyard workflow builder; Gateway and workflow experiments are under the account menu.

This is a bounded first implementation, not complete understanding of arbitrary repositories. Source discovery identifies supported entry points; recording supplies evidence of actual execution. A passing test command establishes only that the configured tests passed.

## GitHub: one-time deployment setup

This section is for the person hosting Traceyard, not every customer installing it.

1. Deploy Traceyard at a public HTTPS origin. GitHub cannot send webhooks or test results to localhost. Review/apply migrations 0008, 0009 and 0010 and deploy the `REPOSITORY_DISCOVERY` Workflow binding in wrangler.jsonc. Production resources have not been deployed by this change.
2. Register a GitHub App, separate from the existing OAuth sign-in app. Set its webhook URL to `https://YOUR_HOST/api/github/webhook`, content type JSON, and a strong webhook secret. Subscribe to **Installation** and **Workflow run** events. Set its post-install setup URL to your Traceyard project page. Keep existing installations updated when adding these event subscriptions.
3. Request repository permissions: **Contents read/write**, **Pull requests read/write**, **Workflows read/write**, and **Actions read/write**. Metadata is read-only. Writes are used to propose the one-time workflow installation PR and dispatch checks. This initial release links personal installations whose GitHub account ID matches the signed-in identity; organization/team delegation is not implemented.
4. Store these server values:

```text
PUBLIC_APP_ORIGIN=https://YOUR_HOST
GITHUB_APP_ID=<App ID>
GITHUB_APP_SLUG=<App slug>
GITHUB_APP_PRIVATE_KEY=<PKCS#8 PEM private key; secret>
GITHUB_APP_WEBHOOK_SECRET=<matching webhook secret; secret>
TRACEYARD_RUNNER_REF=<immutable 40-character Traceyard commit containing agent/ and its lockfile>
```

Convert a downloaded PKCS#1 GitHub RSA key to PKCS#8 locally if necessary:

```bash
openssl pkcs8 -topk8 -nocrypt -in github-app.pem -out github-app-pkcs8.pem
```

Keep both private-key files out of Git and put the resulting key in the deployment secret store. Multiline PEM or literal `\n` separators are accepted. `TRACEYARD_RUNNER_REF` is not a credential. Pin the reviewed implementation commit, not the pre-feature main commit and not a moving branch.

These are different from `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, which continue to authenticate user sign-in. No personal GitHub token is requested from the developer.

When developing through an HTTPS tunnel or reverse proxy, set `PUBLIC_APP_ORIGIN` to the exact public origin and restart Traceyard after changing it. Cookie-authenticated writes accept this explicitly configured origin even when the proxy forwards to local HTTP. Other origins and cross-site browser writes remain blocked; forwarded headers do not grant access. An already installed app offers **Manage access** for changing its repository selection rather than asking you to install it again.

Microsoft Dev Tunnels can also rewrite the browser's `Origin` to its local HTTP target while Vite preserves the forwarded HTTPS protocol in the Worker URL. With a valid public origin configured, Traceyard accepts that transport counterpart only on the identical loopback host and effective port. Other ports, non-loopback protocol mismatches and cross-site requests stay rejected. Rejections include address-only diagnostics (`browserOrigin`, `requestOrigin`, `configuredOrigin`), never keys, cookies or URL paths.

## GitHub: developer journey

1. Sign in and select **Connect repository** (also available in the project switcher). Install Traceyard on selected personal GitHub repositories if necessary, return and refresh the list. Signed installation webhooks and the signed-in identity establish access; callback query strings do not grant it.
2. Choose a repository. Traceyard creates a named project automatically, or opens the already connected project without duplicating it. A durable background Workflow starts source discovery and test setup independently. Initial source coverage is bounded to 60 eligible files, each up to 64 KB, and 100 operations. Discovered operations appear incrementally, with exact commit/file links and coverage warnings.
3. While discovery continues, Traceyard prepares a reviewable PR adding `.github/workflows/traceyard.yml`. Stable branches and read-before-write let a failed setup resume without creating another branch/PR. Existing different workflow content is never overwritten. **Review setup PR** is the one first-run action: review npm scripts and merge it. This grants permission to execute the configured scripts; there is no silent arbitrary application execution before that merge.
4. Merging the workflow into the default branch starts the initial GitHub-hosted Ubuntu job. It installs the pinned runner's production dependencies, indexes source, runs `npm ci`, an existing build script if present, then existing tests with supported Node recording. A lockfile is required. Missing/unsupported tests are shown as not tested. If neither build nor tests exists, the local/hosted agent skips dependency installation entirely after indexing.
5. GitHub displays real logs; Traceyard displays check phases and recorded application runs. **Check project** starts source refresh and a bounded test run in the background together. **Refresh source** performs discovery only. Tests exercise only the paths reached by the existing suite: this does not generate tests, run arbitrary exported functions or promise full workflow coverage. **View recorded application runs** filters real spans by check identity.

### Runtime and cost limits

There is no persistent application server in this flow. The initial run is automatic after the setup PR merges. Later runs are requested explicitly; ordinary application pushes do not start another job. Changing the installed workflow itself also triggers a check. The generated workflow limits the entire job to **10 minutes**, each application command to **180 seconds**, cancels overlapping jobs for the same ref, caches npm downloads and installs only production runner dependencies. API dispatch rejects active runs, holds a queued-run lease for 10 minutes and has a 60-second repeated-request cooldown. This limits accidental duplicates, not total monthly spending.

GitHub Actions usage belongs to the repository owner. Standard public-repository runners are free under GitHub's current terms; private-repository usage draws from the account's included compute usage and may incur charges beyond it. See [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions). Test scripts can also call external services at their own cost; no provider credentials or application secrets are automatically supplied. Traceyard does not estimate a bill from a successful test. Review account budgets separately.

Source and test setup retain independent progress/error state. One failing does not erase the other's results. A real Workflow integration test checks that both stages settle and retain their errors when service configuration is absent. A stale setup can be retried; runtime dispatch failures release their queue lease for retry.

GitHub runners authenticate reports with short-lived OIDC identities instead of stored Traceyard API keys. The receiver verifies the GitHub signature/JWKS, issuer, exact audience, repository/owner IDs, default branch, expected workflow path, GitHub-hosted environment, event type, commit and run identity. Suspended/deleted personal installations are rejected. The workflow does not run on fork PRs or pull_request_target; the source checkout does not persist Git credentials. OIDC identities allow writes only to their linked Traceyard project.

GitHub App/runner API exchanges are integration-tested with explicit service doubles, including valid RSA/HMAC signatures. Live installation, PR creation and GitHub-hosted execution remain to be verified with configured deployment credentials. They have not occurred in this workspace.

## Local code

Requires Node.js 22.12+, a Traceyard checkout with `npm ci`, and a project key with `traces:write`. There is not yet a published npm package; the executable currently ships in this repository.

In the target application's directory, create `.env.traceyard`:

```text
TRACEYARD_ORIGIN=http://localhost:5173
TRACEYARD_KEY=<project key entered privately>
```

Add `.env.traceyard` to that application's .gitignore. The agent reads this named file through Node's native environment loader. The key stays out of source reports and child build/install environments. Runtime recording needs its credential in the test process's exporter configuration; use test-only applications/configuration and do not run untrusted scripts. Localhost is appropriate only when the application process can actually reach that Traceyard server.

```bash
# Offline source discovery; no network or application execution:
node /path/to/traceyard/agent/cli.mjs scan .

# Upload source index into the key's project; no application execution:
node /path/to/traceyard/agent/cli.mjs connect .

# Install dependencies and run the project's existing build/tests with recording:
node /path/to/traceyard/agent/cli.mjs run .
```

Local discovery skips symlinks, environment files, generated/vendor/dependency directories and test/declaration files. It bounds source files and reports omitted coverage. It uploads operation names, source locations, direct call names and scan warnings, not raw source contents. Reports identify a Git commit when available; an uncommitted directory is explicitly labelled. Local reports use the existing expiring/revocable project API key and its request quota.

`run` executes the target application's package scripts. It is not a deployment or a persistent production agent. It can only observe behavior that the existing test suite actually exercises. A project with no test script is shown as skipped, never passed. Test failures produce a nonzero exit code and retained failed phase evidence.

## What is automatically discovered or recorded

Source discovery uses a TypeScript/JavaScript parser, not text matches inside comments/strings. It recognises conventional Express/Hono/Fastify-style HTTP router declarations, Next.js API route exports, Deno.serve, and selected queue/cron declarations. It resolves direct named local handlers and lists their direct calls. It does not resolve every import, dynamic branch, distributed boundary or application-level business workflow. Operation source location is evidence, not proof that the path ran.

Runtime recording uses OpenTelemetry's Node instrumentation for supported libraries. HTTP client/server activity is verified using a real spawned npm test project, without adding wrappers to that project's application code. The Node preload flushes short-lived test processes before natural exit and bounds exporter timeouts. Tests are sampled fully within this bounded test process. A build alone does not exercise all application routes.

OTLP ingestion currently accepts HTTP JSON at `/api/v1/otlp/v1/traces`, up to the existing 32 KB body limit and 50 spans/batch; the agent batches at 32. Protobuf, metrics and logs ingestion are not implemented. The receiver preserves real IDs, parent relationships and timestamps while selecting only operational attributes. Raw prompts, outputs, SQL statements, full URLs and arbitrary payload attributes from automatic instrumentation are excluded. Error type may be retained; sensitive exception messages are not collected automatically. Existing manual trace ingestion remains available.

Node startup instrumentation does not automatically cover remote Deno/Supabase Edge Functions, Python, browser-only execution, arbitrary custom functions or a preconfigured competing OpenTelemetry SDK. Those require runtime-specific integration. Saved per-operation HTTP request tests now run against a configured local npm application process; see [project experience](PROJECT_EXPERIENCE.md). Arbitrary-function replay, visual-to-code editing and automatic business-logic fixes are not included. Source scans and observed runs are presented together but not claimed to be a complete inferred dependency graph.

## Verification and release boundary

At this checkpoint, 82 unit tests and 93 Worker integration tests pass. Automated checks cover scanner correctness, actual spawned npm runs that pass/fail/have no tests, compatible automatically exported HTTP spans, D1 project isolation, OTLP ingestion into unified activity, report transitions, signed installation and runner identity checks, pinned source scan, setup PR generation/dispatch, and terminal report immutability.

Earlier browser QA uses the separate local acceptance account/config. The latest automatic-setup revision could not be visually checked because the cloud browser could not access the local preview; no fresh visual acceptance is claimed. It checks the new Project/Build navigation, visible local environment instructions, missing GitHub configuration state and retained managed execution in unified activity. It does not claim live GitHub OAuth or installation, remote application execution or physical-phone acceptance.

Before release: configure and test a personal GitHub App on a publicly reachable test deployment; merge its installation PR in a disposable Node application; verify real GitHub action stages/results/spans, cancellation and installation removal; verify the supported runtime against the actual application; complete device/layout checks. Do not describe this as arbitrary-codebase automatic understanding or a fully verified Vercel replacement.
