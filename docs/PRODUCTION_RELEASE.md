# Production release

Merging a pull request starts the full checks on `main`. Once every check succeeds, `Deploy TraceYard` checks out and deploys that exact commit. Pull-request workflows cannot trigger the production job, and a revision superseded on `main` is refused.

The current path builds twice: CI builds and validates the revision, then the deployment job checks out the same revision and rebuilds it before applying pending D1 migrations, syncing the reviewed runner pin, and deploying the Worker and assets. It does not promote a persisted CI build artifact. Deployment checks public source revision, database health, protected-resource metadata, and the MCP authorization challenge afterward. A browser authorization and one focused repository test are still required for acceptance.

## Database baseline

A fresh database applies every file in `migrations/` in order. Migration `0025` drops tables left by the retired workflow engine. Check a fresh local copy with:

```sh
npx wrangler d1 migrations apply traceyard-prod-db --local
```

## One-time credential setup

Use a Cloudflare API token restricted to the target account and resources. It must cover the operations actually performed by the deployment script:

- D1 remote migrations for the production database.
- Worker/script deployment and the Workflows/Durable Object bindings selected by the config.
- Writing the `TRACEYARD_RUNNER_REF` Worker secret.
- Best-effort cleanup of retired Queue/Workflow resources, if those resources still exist in the account.

Store the token in the GitHub repository's encrypted Actions secret named `CLOUDFLARE_API_TOKEN`. Existing production application secrets remain on the Worker; never copy them into the repository or build output. Validate the token and account against a non-production environment before using it for the live origin. The configured account ID and public origin are maintained in the release workflow and must be changed together if hosting moves.

## Local hosting

Create a GitHub OAuth application with a callback at `http://localhost:5173/api/auth/github/callback`. Save its credentials in an ignored `.dev.vars` file before running `npm run dev`.

```text
PUBLIC_APP_ORIGIN=http://localhost:5173
GITHUB_CLIENT_ID=<OAuth client ID>
GITHUB_CLIENT_SECRET=<OAuth client secret>
```

Use a separate HTTPS callback and encrypted secrets for a deployed instance. For GitHub repository runs, configure the App in [repository setup](REPOSITORY_SETUP.md).

## Deploy from a checkout

Before running a live deployment, confirm all of the following:

- The checkout is clean and on `main`, unless `--validated-revision` is intentionally used by the CI deployment workflow.
- The exact commit is the intended release and is fetchable by GitHub.
- Node.js 22.12.0 or newer is available; `npm ci`, `npm test`, and `npm run build` pass.
- The reviewed 40-character runner revision in `shared/repository/runner-version.ts` is published and fetchable.
- Wrangler is authenticated to the intended Cloudflare account with D1 migration, Worker deploy, secret-write, and required binding permissions.

The command changes remote state: it applies migrations, updates the runner secret, deploys the Worker, and may clean up retired resources. Do not run it against an unintended account.

```sh
npm ci
npm test
npm run build
npx wrangler login
npm run deploy:investigations -- --origin https://your-traceyard-host.example
```

After deployment, verify the public origin, complete one browser authorization in **Agents**, connect a disposable test repository, and run one focused repository test. See [CHANGELOG.md](../CHANGELOG.md) for hosted verification records.
