# Repository connection and checks

## Developer flow

1. Sign in with GitHub and grant the Traceyard GitHub App access to selected repositories.
2. Choose **Connect repository**. TraceYard creates or reopens the repository resource and starts source discovery.
3. In **Investigations**, choose **Review workflow change**, inspect the one-file preview, and choose **Create setup PR**. Hosted tests become available once you or a maintainer merge that PR into the default branch on GitHub. If you're blocked, use a maintainer-approved test fork or run the test locally at both commits and retain the output.
4. In **Investigations**, select the existing Vitest test file and the full SHA checked out by the failing run. Traceyard can fill the SHA from a GitHub Actions link when it can identify one checkout for the repository in the job log. If the run has multiple failing jobs, provide the specific job link. For a custom checkout, enter the tested SHA yourself.

Traceyard refreshes the signed-in personal account’s existing installation directly from GitHub. Installations created before the current deployment are recovered without a new installation webhook or reinstall. A failed GitHub lookup is shown as a refresh error rather than an empty install prompt.

Connecting, scanning, and previewing do not write repository files. After you approve the exact preview, Traceyard opens a PR that creates or updates only `.github/workflows/traceyard.yml`. Merge it on GitHub under your repository rules. Existing workflows that use an older runner follow the same process.

Source discovery finds supported entry points and direct static calls. These are candidate application operations, not proof of a complete business workflow or of successful execution. Actual runs appear only when tests or application activity produce supported telemetry.

## Source flow without application credentials

Connecting and browsing source never require a Groq, Supabase or other application service key. Source discovery does not execute repository code. Open any discovered operation to inspect its possible calls before running checks. The parser expands unambiguous top-level local functions within the same file, annotates conditional/callback/loop/catch paths and leaves imported, computed or dynamically assigned implementations unresolved. Unused function bodies are not treated as executed calls. The view is bounded to 12 calls and three levels of local helpers; recursion and truncation are explicit. On the free hosted preview, deeper helper expansion is limited to files of at most 4 KB to control per-step CPU use; larger eligible files retain direct calls. A runner built from this revision can add deeper metadata for its wider source scan. Older pinned runners remain compatible and do not erase same-commit helper metadata. It does not infer a complete business workflow, actual branch selection or execution order.

GitHub execution needs a reviewed workflow file. Traceyard prepares that change for your review.

Tests that call a database or another service need the corresponding test credentials in their runner. The source index remains available if those tests fail.

## When something fails

| Failure                                | What remains available                                         | Next action                                                                                              |
| -------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Source scan cannot read GitHub         | Last successful source index and recorded history              | Check access and retry discovery                                                                         |
| Dependency installation or build fails | Source operations, their code links and history                | Read the failed stage and correct the prerequisite                                                       |
| Tests fail                             | Source operations and any activity recorded before the failure | Inspect the failed stage or recorded run; request a new attempt when ready                               |
| One saved HTTP test fails              | Other operations and saved tests                               | Correct its input or application issue; run an independent test if its prerequisites work                |
| Runner is interrupted or loses contact | Source operations and retained evidence                        | Outcome is unconfirmed; Traceyard closes expired checks without automatically repeating application work |
| GitHub setup cannot merge              | Source discoveries and history                                 | Traceyard shows the blocking repository requirement; no check is claimed to have started                 |

An unavailable database can prevent an operation that needs that database from executing. Traceyard cannot safely bypass application prerequisites. Browsing source is independent. A selected HTTP request test can start the selected application directly instead of requiring an unrelated root build, but the configured startup script must prepare everything that application needs.

Check records, frozen settings and managed request IDs are retained for 30 days. Retries of the same managed request ID within that window return the original check and frozen commit/configuration. Reusing an ID for a different saved request conflicts. An intentional new attempt has a new ID. This prevents duplicate job launches; it does not replace application-level idempotency for an external payment, email or other side effect. Checks must use test data and test services.

## One-time operator setup

This is configured once by the Traceyard operator. Individual developers install the existing App; they do not create another GitHub App or supply its private key.

The current connection implementation supports personal GitHub accounts. Create/configure one GitHub App with:

- Repository **Contents: read/write**, **Pull requests: read/write**, **Workflows: read/write**, **Actions: read/write**, **Metadata: read**.
- **Push** and **Workflow run** webhook events. GitHub sends installation lifecycle events automatically.
- Public HTTPS webhook URL: `https://YOUR_TRACEYARD_HOST/api/github/webhook`.
- A securely generated webhook secret. Keep the App private key in the Worker secret store.

GitHub sign-in OAuth configuration remains separate from repository installation. The sign-in callback is `https://YOUR_TRACEYARD_HOST/api/auth/github/callback`.

Required environment values:

```text
PUBLIC_APP_ORIGIN=https://YOUR_TRACEYARD_HOST
GITHUB_CLIENT_ID=<sign-in OAuth client ID>
GITHUB_CLIENT_SECRET=<sign-in OAuth secret>
GITHUB_APP_ID=<repository App ID>
GITHUB_APP_SLUG=<repository App slug>
GITHUB_APP_WEBHOOK_SECRET=<secret>
GITHUB_APP_PRIVATE_KEY=<PKCS#8 PEM private key>
```

A literal `\n`-separated PEM is accepted. Convert a downloaded PKCS#1 key locally if needed:

```bash
openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out github-app-pkcs8.pem
```

Never commit key files or environment secrets. GitHub workflows use a pinned, reviewed agent revision (`TRACEYARD_RUNNER_REF`, or the checked-in default). Updating the workflow revision requires the same in-app approval. The managed agent is baked into its deployed image.

### Free Cloudflare deployment (default)

The default deployment contains the web app, API, D1, discovery Workflows, cron, and deployment variables. It does not provision Containers or change your billing plan. Historical Queue resources are legacy and may be cleaned up by deployment; no active Queue binding is required. Project code runs on the repository owner's GitHub-hosted Actions runner. GitHub's included allowance and repository Actions policy apply; private-repository execution is not unlimited. GitHub OIDC authenticates the runner without a customer-entered TraceYard key. The setup PR is prepared inside TraceYard and merged on GitHub. The local CLI remains optional.

After reviewing the account/resource IDs and authenticating Wrangler:

```bash
npm ci
npm run db:migrate:remote
npm run deploy
```

The default config bounds hosted discovery to 16 eligible JavaScript/TypeScript files of at most 16 KB each. Discovery processes one file per persisted step and labels incomplete coverage. Large repository tree parsing can still exceed free CPU limits; local discovery is the fallback. Failed rescans keep the previous successful index. TraceYard-managed D1/check records follow the documented 30-day retention; GitHub workflow logs and artifacts follow the connected repository or organization GitHub Actions retention policy.

Configure the existing GitHub credentials once, from the operator's own Traceyard checkout containing `.dev.vars`:

```bash
npm run configure:cloudflare -- --origin https://YOUR_TRACEYARD_HOST --account YOUR_ACCOUNT_ID
```

This script uploads only the required configuration names through Wrangler stdin, converts the App RSA private key to PKCS#8 in memory, and prints no credential values. It preserves an existing integration encryption key. It requires an active Wrangler login. Update the GitHub OAuth callback and App webhook to the stable URLs printed afterward. These are operator steps; Traceyard's customers do not repeat them.

### Optional hosted execution (paid, explicit opt-in)

`wrangler.managed.jsonc` adds a Durable Object and a repository runner Container. This requires Cloudflare Workers Paid with Containers enabled, plus an image build or previously uploaded digest-pinned image. It is **not** part of the free deployment.

Only an operator who has chosen and provisioned that infrastructure should run:

```bash
npm run deploy:managed
```

Both deploy scripts build their selected mode first, then deploy the explicit generated config at `dist/worker/wrangler.json`; they do not reuse a different mode's prior build by accident. See [managed execution](MANAGED_EXECUTION.md) for its limits and release checks. Ordinary `npm run dev` stays Docker-free; `npm run dev:managed` is the separate local Container development mode.

## Current runtime support and limits

- Node.js 22.12.0 or newer, npm lockfile installs, existing `build`/`test` scripts. A selected npm workspace may use the repository's shared lockfile if it contains that workspace. Other package managers/runtimes are not automatically executed.
- The free GitHub discovery preview reads at most 16 eligible JavaScript/TypeScript files, each at most 16 KB; managed deployments allow up to 60 files of 64 KB. It exposes up to 100 operations and labels coverage limits. A downloaded agent scan can inspect up to 10,000 eligible files, with the same file/operation bounds.
- Managed execution deadline: 10 minutes; each application command/request-test process is bounded to 180 seconds. Managed execution uses a Cloudflare Container orchestrated by a Durable Object; it is not part of the ordinary free deployment.
- At most 6 accepted checks per project per hour; default global concurrency is 2 (`MANAGED_CHECK_CONCURRENCY_LIMIT`, bounded 1–8). These are capacity limits, not a monthly spending guarantee. Pushes beyond the project allowance still update source discovery.
- Each check uses a fresh workspace. GitHub settings/request fixtures are frozen at dispatch; code comes from the default-branch commit selected by GitHub when dispatch starts. Managed checks freeze both commit and settings. The GitHub runner caches npm package downloads and still runs `npm ci` in each checkout. External services, private registry authentication and application secrets are not inferred or provisioned.
- Supported Node HTTP activity is recorded automatically during tests. Mocked/in-process tests can pass without recording a trace. Continuous monitoring of an already deployed application requires that application's runtime integration; repository access alone does not instrument production.
- Visual business-logic editing, automatic fixes/commits and arbitrary workflow replay are not implemented.

### Focused tests

Use a committed `package-lock.json` and a direct script such as `vitest run` or `jest`. When a package has several suites, use an explicit test path and a script named for that suite, such as `test:unit` for files under `tests/unit`. Traceyard retains the test result from the selected commit. Verification identifies test, fixture, mock and snapshot paths using common naming conventions. Review the candidate diff when your project keeps fixtures elsewhere.

React and TypeScript use the project's existing transforms and test configuration. React Native runs JavaScript and component tests through Jest with the project's preset. Native device tests require their own iOS or Android runner. Interaction replay is available for eligible Vitest tests.

The GitHub download cache uses the repository and runner lockfiles. Each check installs from the selected commit and runs its tests. Traceyard does not restore `node_modules`, build output, or test results across commits. Repositories with an existing build tool cache can use it inside their own build script.

## Runner update for existing deployments

The [reviewed runner revision](../shared/repository/runner-version.ts) includes focused investigations, fresh-checkout Vitest flakiness checks, npm lockfile installs and Vitest interaction replay. Ordinary application ESM hooks and supported Node HTTP recording remain available. Focused tests have a two-minute budget and the GitHub job has a ten-minute limit. Existing deployments must update their server runner pin and review the generated workflow update; old runners are refused before receiving focused plans. See [production release](PRODUCTION_RELEASE.md).

An existing deployment can select this immutable revision through its operator-controlled `TRACEYARD_RUNNER_REF` setting. The repository workflow must use the same revision; Traceyard validates the exact generated workflow before dispatch. Application test fixes and runner updates are separate changes. Mock-only tests do not establish observed application activity, and batch exporters may lose the final spans of a worker that is forcibly stopped.

## GitHub check recovery

A durable request ID prevents an uncertain response from dispatching a second job. The generated workflow includes that request in its run name, so polling can recover a missed runner callback. Pending requests become unconfirmed after ten minutes without a matching runner. Active jobs have a ten-minute GitHub deadline and individual application commands have a three-minute deadline. Cancellation before runner binding prevents application commands from starting. Source discovery remains independent.

The workflow is dispatch-only; default-branch push webhooks request checks through Traceyard, avoiding a second automatic workflow triggered by the setup merge. Frozen manifests are bound to one GitHub run/attempt and expire after 30 minutes. Dispatch records and check manifests are retained for 30 days. Application credentials, databases and external service prerequisites are not invented by repository access; missing prerequisites produce an actionable failed stage.

## Local CLI

Create a project-scoped key with `traces:write`. In the target repository, create an ignored `.env.traceyard`:

```text
TRACEYARD_ORIGIN=https://YOUR_TRACEYARD_HOST
TRACEYARD_KEY=<project-scoped API key>
```

Only `TRACEYARD_ORIGIN` and `TRACEYARD_KEY` are read from this file; other lines are ignored, and values already set in the environment take precedence. Hosted runs (GitHub Actions and managed checks) never read it, because it is repository content. The key is used by the runner only: your tests export traces through a loopback relay and never receive it. See [execution trust](EXECUTION_TRUST.md).

With Node.js 22.12.0 or newer and Git, run this from that repository (no separate TraceYard checkout required):

```bash
npm exec --yes --ignore-scripts --package=git+https://github.com/fysaio/traceyard.git#6bfde2973ff92f322b6d575e60a3212e2474bbcc -- traceyard run .
```

The command installs an immutable reviewed runner revision into npm's cache. In TraceYard, **Run locally** creates a scoped project key and provides the environment template and copyable command. To use an existing TraceYard checkout instead:

```bash
node /path/to/traceyard/agent/cli.mjs scan .
node /path/to/traceyard/agent/cli.mjs connect .
node /path/to/traceyard/agent/cli.mjs run .
```

`scan` only prints source discoveries locally. `connect` uploads discovery without running application commands. `run` installs locked dependencies and executes configured checks on your machine. Local scripts receive your local environment except TraceYard's API key; configure test services deliberately. This runner flow is separate from the public npm CLI, which is available as `npx traceyard@0.1.0`.

## The Traceyard action

The runner steps are also packaged as a composite action, [`action/action.yml`](../action/action.yml):

```yaml
  - uses: fysaio/traceyard/action@e388d18620cbd2435ef5f4998353091fd3b635d4
  with:
    run-request: ${{ inputs.run_request }}
    origin: https://YOUR_TRACEYARD_HOST
```

It installs the runner's locked dependencies with lifecycle scripts off, prepares the trusted runner and runs the check. Use a published, reviewed, fetchable 40-character SHA; never use an unpublished local `HEAD`. The moving `fysaio/traceyard/action@v1` tag becomes available only after a 1.x release and then moves with 1.x releases. See [releasing](RELEASING.md). The workflow that TraceYard proposes during setup is the one it dispatches and checks, and it still pins the runner by full commit SHA.
