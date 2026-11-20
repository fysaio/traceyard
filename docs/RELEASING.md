# Releasing

One semver tag publishes the release artifacts. The current release is `0.1.0` (`v0.1.0`); the action major tag is intentionally not available during the 0.x series.

| What                | Where                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------- |
| CLI and MCP server  | npm [`traceyard`](https://www.npmjs.com/package/traceyard), with provenance                 |
| Same package        | GitHub Packages `@fysaio/traceyard`                                                         |
| Self-hosted app     | `ghcr.io/fysaio/traceyard`, linux/amd64 and linux/arm64, signed, SBOM and provenance        |
| Managed runner base | `ghcr.io/fysaio/traceyard-runner`, linux/amd64 and linux/arm64, signed, SBOM and provenance |
| GitHub Action       | A full reviewed SHA today; `fysaio/traceyard/action@v1` only after the first 1.x release    |
| Release notes       | A GitHub release generated from the version's `CHANGELOG.md` section                        |

Images are tagged `X.Y.Z`, `X.Y`, and `latest`; the moving `X` major tag begins with 1.0.

## Cut a release

1. On a branch, set the release version consistently in `packages/cli/package.json`, `packages/core/package.json`, `wrangler.jsonc`, and `wrangler.managed.jsonc`. The workflow currently validates the CLI package/tag relationship; the other values are a manual convention that should be reviewed together.
2. In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z` and start a new empty `## Unreleased` above it.
3. Merge the pull request. This deploys the hosted app as usual when the main-branch checks and deployment workflow succeed.
4. Tag the merge commit on `main` and push the tag:

   ```bash
   git checkout main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

The [Publish release](../.github/workflows/publish.yml) workflow refuses a tag that does not match `packages/cli/package.json`, is not on `main`, or has no changelog section. It runs the CLI tests, installs the packed package from a clean directory, builds both images for both architectures, then publishes and signs the artifacts.

To check the whole pipeline without publishing, run **Publish release** by hand from the Actions tab with **dry run** enabled.

## One-time setup

- **`NPM_TOKEN`** repository Actions secret: an npm granular access token with publish rights to `traceyard`. GitHub Packages and GHCR use the workflow's own `GITHUB_TOKEN`.
- After the first image push, open each package under the organization's **Packages** and set its visibility to **Public**, so `docker pull` works without signing in.
