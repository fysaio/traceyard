# Self-hosting

Run Traceyard on your own machine or server with Docker. Its database is SQLite, stored in a volume. You don't need a Cloudflare account.

```bash
curl -O https://raw.githubusercontent.com/fysaio/traceyard/main/docker-compose.yml
docker compose up -d
open http://localhost:8787
```

`docker compose up` uses the published image `ghcr.io/fysaio/traceyard`. From a clone of this repository, `docker compose up --build` builds the image from source instead. Set `TRACEYARD_VERSION` to pin a release, e.g. `TRACEYARD_VERSION=1.0.0`.

## What runs

The image runs the same build that serves the hosted app: the web app, the API and the MCP server at `/mcp`. They run on [workerd](https://github.com/cloudflare/workerd), the open-source Workers runtime, through `wrangler dev --local`.

- **Database:** SQLite files in `/data` (the `traceyard-data` volume). Migrations are applied each time the container starts, so upgrading is `docker compose pull && docker compose up -d`.
- **Scheduled jobs:** the container runs the jobs that Cloudflare runs on a cron in production every five minutes. They close checks that stopped reporting, maintain investigations, and delete records older than 30 days and expired sessions. The endpoint they use is protected with a secret generated at start-up.
- **Repository discovery:** runs as a local Workflow inside the same process.
- **Health:** `GET /api/health` reports the database status and the image revision. Docker's `HEALTHCHECK` uses it.

To back up, stop the container and copy the volume. To start again from an empty database, run `docker compose down -v`.

## Sign-in and repositories

Without GitHub credentials, the app starts with sign-in turned off, and you can still open the example. To sign in and connect repositories, create a GitHub OAuth app and a GitHub App as described in [repository setup](REPOSITORY_SETUP.md#one-time-operator-setup). Use your own host in the URLs:

- Sign-in callback: `https://YOUR_HOST/api/auth/github/callback`
- App webhook: `https://YOUR_HOST/api/github/webhook`. GitHub must be able to reach it, so put the container behind HTTPS (for example Caddy, nginx or a tunnel).

Put the values in a `.env` file next to `docker-compose.yml`:

```text
PUBLIC_APP_ORIGIN=https://YOUR_HOST
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_APP_ID=...
GITHUB_APP_SLUG=...
GITHUB_APP_WEBHOOK_SECRET=...
GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app-key
```

Every value also works as `NAME_FILE` pointing at a file, which suits Docker secrets. The App private key may be the PKCS#1 key GitHub gives you, because it is converted to PKCS#8 at start-up. Never commit `.env` or key files.

| Variable              | Default                 | Meaning                                    |
| --------------------- | ----------------------- | ------------------------------------------ |
| `PUBLIC_APP_ORIGIN`   | `http://localhost:8787` | The URL people and GitHub use to reach it. |
| `TRACEYARD_PORT`      | `8787`                  | Host port in `docker-compose.yml`.         |
| `TRACEYARD_VERSION`   | `latest`                | Image tag to run.                          |
| `TRACEYARD_LOG_LEVEL` | `info`                  | `debug`, `info`, `warn` or `error`.        |

## Running checks

Repository checks run in the repository's own GitHub Actions, using the workflow Traceyard proposes during setup. The workflow sends results to `PUBLIC_APP_ORIGIN`, so self-hosted results stay on your server. The workflow pins the Traceyard runner to a full commit SHA, so a change to this repository can't change what runs in your CI until you approve the updated workflow.

Managed checks, which run on Traceyard's own containers, are only available on the hosted service. The runner image `ghcr.io/fysaio/traceyard-runner` is published for that deployment and for your own isolated runs. It contains Node 22, git, Python 3 and the runner agent, and runs as the unprivileged `node` user.

## Limits

The local Workers runtime is a good fit for one team on one machine. It does not replicate the database or spread work across servers. For higher load, use the hosted service or [deploy to Cloudflare](PRODUCTION_RELEASE.md).

## Verify an image

Release images are signed with [cosign](https://docs.sigstore.dev/) through GitHub's OIDC identity, with no long-lived key. They also carry an SBOM and SLSA provenance.

```bash
cosign verify ghcr.io/fysaio/traceyard:latest \
  --certificate-identity-regexp '^https://github.com/fysaio/traceyard/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
docker buildx imagetools inspect ghcr.io/fysaio/traceyard:latest --format '{{ json .SBOM }}'
```
