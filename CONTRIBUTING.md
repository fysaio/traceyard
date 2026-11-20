# Contributing to TraceYard

A good first contribution is a reproducible report or a small fix. Browse the [good first issues](https://github.com/fysaio/traceyard/labels/good%20first%20issue), or [open an issue](https://github.com/fysaio/traceyard/issues/new) with what you did, what you expected, and what happened. Include the test command or a small public sample when you can. Use synthetic data and keep credentials out of logs and screenshots.

## Local setup

TraceYard requires Node.js 22.12.0 or newer and npm.

```sh
npm ci
npm test
npm run lint
npm run build
```

For ordinary development, run `npm run dev`. For the disposable local browser-test environment, run `npm run dev:acceptance`; it uses acceptance migrations and does not require GitHub credentials. Open [the local test account](http://localhost:5173/__acceptance/account) and choose **Open local test account**. GitHub sign-in and repository-backed runs require the [repository setup guide](docs/REPOSITORY_SETUP.md).

## Tests

The default unit/integration test command is `npm test`. Run the default end-to-end suite with:

```sh
npx playwright install --with-deps chromium
npx playwright test
```

The investigations acceptance suite uses its own server. Stop any development server first, then run:

```sh
npx playwright test --config playwright.investigations.config.ts
```

Changes under `agent/`, `runner/`, CLI packaging, Docker/self-hosting, or browser replay may have additional CI jobs. The authoritative job definitions are in [.github/workflows/ci.yml](.github/workflows/ci.yml); inspect the changed-area jobs before opening a pull request.

## Open a pull request

Run the checks that cover your change, describe the behavior that changed, and include the exact commands and environment used. A screenshot helps for UI changes. Add an entry to [CHANGELOG.md](CHANGELOG.md) when users will notice the change. Keep generated workflows pinned to a published, reviewed, fetchable 40-character TraceYard commit SHA; do not use an unpublished local `HEAD`.

Report security vulnerabilities [privately through GitHub](https://github.com/fysaio/traceyard/security/advisories/new).
