# Releasing

One tag publishes everything. Versions follow [semver](https://semver.org/).

| What               | Where                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------- |
| CLI and MCP server | npm [`traceyard`](https://www.npmjs.com/package/traceyard), with provenance                 |
| Same package       | GitHub Packages `@fysaio/traceyard`                                                         |
| Self-hosted app    | `ghcr.io/fysaio/traceyard`, linux/amd64 and linux/arm64, signed, SBOM and provenance        |
| Runner             | `ghcr.io/fysaio/traceyard-runner`, linux/amd64 and linux/arm64, signed, SBOM and provenance |
| GitHub Action      | `fysaio/traceyard/action@v1`, a major tag moved to each 1.x release                         |
| Release notes      | A GitHub release, from the version's `CHANGELOG.md` section                                 |

Images are tagged `X.Y.Z`, `X.Y`, `X` (from 1.0 on) and `latest`.

## Cut a release

1. On a branch, set the version in `packages/cli/package.json`, `packages/core/package.json` and the `APP_VERSION` var in `wrangler.jsonc` and `wrangler.managed.jsonc`.
2. In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z` and start a new empty `## Unreleased` above it.
3. Merge the pull request. This deploys the hosted app as usual.
4. Tag the merge commit on main and push the tag:

   ```bash
   git checkout main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

The [Publish release](../.github/workflows/publish.yml) workflow refuses a tag that doesn't match `packages/cli/package.json`, isn't on main, or has no changelog section. It runs the CLI tests, installs the packed package from a clean directory and runs it, builds both images for both architectures, then publishes and signs.

To check the whole pipeline without publishing, run **Publish release** by hand from the Actions tab with **dry run** ticked.

## One-time setup

- **`NPM_TOKEN`** repository Actions secret: an npm granular access token with publish rights to `traceyard`. GitHub Packages and GHCR use the workflow's own `GITHUB_TOKEN`.
- After the first image push, open each package under the organization's **Packages** and set its visibility to **Public**, so `docker pull` works without signing in.
