# Repository connection and checks

## Developer flow

1. Sign in with GitHub and grant the Traceyard GitHub App access to selected repositories.
2. Choose **Connect repo**. Traceyard creates or reopens the repository's project and starts source discovery.
3. Open the project. Discovered operations become available without waiting for installation, build or tests to pass.
4. On a managed deployment, Traceyard downloads the selected commit into its own temporary workspace and runs supported checks. Later default-branch pushes refresh discovery and request another bounded check. **Check project** requests a check explicitly.

Connecting does not create a branch, write `.github/workflows/traceyard.yml`, open a setup PR or dispatch customer GitHub Actions. The retired setup and upgrade endpoints return an explanatory error. Previously installed Actions can still report into their existing projects; they are compatibility support, not a prerequisite for new connections. Remove an old Traceyard workflow separately if you no longer want it to run.

Source discovery finds supported entry points and direct static calls. These are candidate application operations, not proof of a complete business workflow or of successful execution. Actual runs appear only when tests or application activity produce supported telemetry.

## When something fails

| Failure                                | What remains available                                         | Next action                                                                                              |
| -------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Source scan cannot read GitHub         | Last successful source index and recorded history              | Check access and retry discovery                                                                         |
| Dependency installation or build fails | Source operations, their code links and history                | Read the failed stage and correct the prerequisite                                                       |
| Tests fail                             | Source operations and any activity recorded before the failure | Inspect the failed stage or recorded run; request a new attempt when ready                               |
| One saved HTTP test fails              | Other operations and saved tests                               | Correct its input or application issue; run an independent test if its prerequisites work                |
| Runner is interrupted or loses contact | Source operations and retained evidence                        | Outcome is unconfirmed; Traceyard closes expired checks without automatically repeating application work |
| Managed execution is not configured    | Source discovery and browsing                                  | Operator deploys the managed execution service                                                           |

An unavailable database can prevent an operation that needs that database from executing. Traceyard cannot safely bypass application prerequisites. Browsing source is independent. A selected HTTP request test can start the selected application directly instead of requiring an unrelated root build, but the configured startup script must prepare everything that application needs.

Check records, frozen settings and managed request IDs are retained for 30 days. Retries of the same managed request ID within that window return the original check and frozen commit/configuration. Reusing an ID for a different saved request conflicts. An intentional new attempt has a new ID. This prevents duplicate job launches; it does not replace application-level idempotency for an external payment, email or other side effect. Checks must use test data and test services.

## One-time operator setup

This is configured once by the Traceyard operator. Individual developers install the existing App; they do not create another GitHub App or supply its private key.

The current connection implementation supports personal GitHub accounts. Create/configure one GitHub App with:

- Repository **Contents: read**, **Metadata: read**.
- **Push** webhook events. GitHub sends installation lifecycle events automatically. Keep **Workflow run** and **Actions: read** only if retaining legacy Actions reporting/status recovery.
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

Never commit key files or environment secrets. `TRACEYARD_RUNNER_REF` is no longer needed for managed checks: the agent is baked into Traceyard's deployed image.

### Free Cloudflare deployment (default)

The default deployment contains the web app, API, D1, Queues and discovery Workflows. It does **not** provision Containers, run arbitrary repository code in the cloud, or change your billing plan. Cloudflare Free quotas still apply. `Run locally` records checks on the developer's computer and sends their results to this hosted dashboard. A customer setup PR is never required.

After reviewing the account/resource IDs and authenticating Wrangler:

```bash
npm ci
npm run db:migrate:remote
npm run deploy
```

The default config bounds hosted discovery to 16 eligible JavaScript/TypeScript files of at most 16 KB each. Discovery processes one file per persisted step and labels incomplete coverage. Large repository tree parsing can still exceed free CPU limits; local discovery is the fallback. Failed rescans keep the previous successful index. Workflow error retention is at most 3 days, while application history is stored independently in D1.

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

- Node.js 22, npm lockfile installs, existing `build`/`test` scripts. A selected npm workspace may use the repository's shared lockfile if it contains that workspace. Other package managers/runtimes are not automatically executed.
- The free GitHub discovery preview reads at most 16 eligible JavaScript/TypeScript files, each at most 16 KB; managed deployments allow up to 60 files of 64 KB. It exposes up to 100 operations and labels coverage limits. A downloaded agent scan can inspect up to 10,000 eligible files, with the same file/operation bounds.
- Managed queue deadline: 10 minutes. Managed execution deadline: 10 minutes; each application command/request-test process is bounded to 180 seconds. VM entrypoint lifetime is at most 15 minutes if the controller fails.
- At most 6 accepted checks per project per hour; default global concurrency is 2 (`MANAGED_CHECK_CONCURRENCY_LIMIT`, bounded 1–8). These are capacity limits, not a monthly spending guarantee. Pushes beyond the project allowance still update source discovery.
- Each check uses a fresh workspace and frozen commit/settings. No persistent service or dependency cache is supplied yet. External services, private registry authentication and application secrets are not inferred or provisioned.
- Supported Node HTTP activity is recorded automatically during tests. Mocked/in-process tests can pass without recording a trace. Continuous monitoring of an already deployed application requires that application's runtime integration; repository access alone does not instrument production.
- Visual business-logic editing, automatic fixes/commits and arbitrary workflow replay are not implemented.

## Local CLI

Create a project-scoped key with `traces:write`. In the target repository, create an ignored `.env.traceyard`:

```text
TRACEYARD_ORIGIN=https://YOUR_TRACEYARD_HOST
TRACEYARD_KEY=<project-scoped API key>
```

From that repository:

```bash
node /path/to/traceyard/agent/cli.mjs scan .
node /path/to/traceyard/agent/cli.mjs connect .
node /path/to/traceyard/agent/cli.mjs run .
```

`scan` only prints source discoveries locally. `connect` uploads discovery without running application commands. `run` installs locked dependencies and executes configured checks on your machine. Local scripts receive your local environment except Traceyard's API key; configure test services deliberately. A published, browser-authenticated CLI installer is not yet shipped.
