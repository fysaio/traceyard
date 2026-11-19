# Contributing to Traceyard

A good first contribution is a reproducible report or a small fix. Browse the [good first issues](https://github.com/fysaio/traceyard/labels/good%20first%20issue), or [open an issue](https://github.com/fysaio/traceyard/issues/new) with what you did, what you expected and what happened. Include the test command or a small public sample when you can. Use synthetic data and keep credentials out of logs and screenshots.

## Run it locally

Use Node.js 22.12 or newer and npm.

```sh
npm ci
npm run dev:acceptance
```

Open [the local test account](http://localhost:5173/__acceptance/account) and choose **Open local test account**. It uses a disposable local database and works without GitHub credentials. For GitHub sign-in or repository runs, follow the [repository setup guide](docs/REPOSITORY_SETUP.md) and run `npm run dev`.

## Open a pull request

Run the checks that cover your change.

```sh
npm test
npm run lint
npm run build
```

For browser changes, run `npx playwright install chromium` and `npx playwright test --config playwright.investigations.config.ts`. The browser suite starts its own local server, so stop your development server first.

In the PR, show the behavior that changed and how you reproduced it. A screenshot helps for UI changes. Add an entry to [CHANGELOG.md](CHANGELOG.md) when users will notice the change.

Report security vulnerabilities [privately through GitHub](https://github.com/fysaio/traceyard/security/advisories/new).
