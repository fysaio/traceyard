# Production release

Merging a pull request starts the full checks on main. Once every check succeeds,
`Deploy Traceyard` deploys that exact commit. Pull-request workflows cannot trigger
the production job. A revision that has been superseded on main is refused.

The release builds once, applies pending D1 migrations, syncs the reviewed runner
pin and deploys the Worker and assets. It verifies the public source revision,
database health, OAuth discovery and MCP authorization challenge afterward.
The CI release does not repeat the already successful full test suite. Local
operator releases retain the complete test gate.

## One-time credential setup

In the Cloudflare account used by `wrangler.jsonc`, create a token restricted to
that account with the permissions needed to deploy this Worker, its Workers
Queues and Workflows bindings, and apply D1 migrations. Do not grant access to
unrelated accounts or zones. Store the token in the GitHub repository's encrypted
Actions secret named `CLOUDFLARE_API_TOKEN`. Existing production application
secrets remain on the Worker; never copy them into the repository or build output.

The configured account ID is the existing Traceyard account. If hosting moves,
update that ID and the public origin in the release workflow together.

If the secret is absent, the release fails immediately with a clear instruction;
it does not wait, prompt for interactive login, or start a retry loop. Add the
secret and rerun the failed release job. A Cloudflare API failure stops the release
at its failing stage; inspect the error before deliberately rerunning it.

## Local hosting

Create a GitHub OAuth application with a callback at `http://localhost:5173/api/auth/github/callback`. Save its credentials in an ignored `.dev.vars` file before running `npm run dev`.

```text
PUBLIC_APP_ORIGIN=http://localhost:5173
GITHUB_CLIENT_ID=<OAuth client ID>
GITHUB_CLIENT_SECRET=<OAuth client secret>
INTEGRATION_ENCRYPTION_KEY=<base64 encoding of 32 random bytes>
```

Use a separate HTTPS callback and encrypted secrets for a deployed instance. Set `OUTBOUND_ALLOWED_HOSTS` if you use outgoing callbacks. Keep the integration encryption key stable so stored credentials remain readable. For GitHub repository runs, configure the App in [repository setup](REPOSITORY_SETUP.md).

## Deploy from a checkout

```sh
npm ci
npx wrangler login
npm run deploy:investigations -- --origin https://your-traceyard-host.example
```

Use the Cloudflare account and bindings for your deployment. The script checks health and the MCP authorization challenge after deploying. See [CHANGELOG.md](../CHANGELOG.md) for hosted verification records.
