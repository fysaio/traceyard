# @traceyard/core

The local test engine. It runs one test file, optionally at an exact commit, and returns a structured result. In this repository it is a private implementation package consumed by the CLI and runner; it is not installed as an npm workspace from the root checkout.

For repository development, import the source module by its relative path from a script run at the repository root:

```js
import { runLocalTest } from "./packages/core/src/index.mjs";

const before = await runLocalTest({ repo: ".", commit: "<full-sha>", testPath: "src/sum.test.ts" });
console.log(before.status, before.failures?.[0]?.message);
```

Run `npm ci` first. The public entry point for this functionality is the released `traceyard` CLI; see [the CLI guide](../../docs/CLI.md).

- **Runners:** Vitest, Jest, and Pytest behind one adapter interface (`src/runners.mjs`).
- **Package managers:** npm, pnpm, Yarn, and Bun, detected from `packageManager` or the lockfile (`src/package-manager.mjs`).
- **Exact commits:** each run at a SHA happens in a throwaway `git worktree`, so your working tree and index are never touched. Missing commits are fetched only when the caller passes `fetch: true` (`src/worktree.mjs`).
- **Installs:** core never installs dependencies by itself. `installCommand()` returns the lockfile-exact, scripts-off command for the caller to run.

The hosted runner (`agent/cli.mjs`) and the released `traceyard` CLI are thin layers over this package. Recorded replays need Docker, so they are passed in by the hosted runner and are blocked otherwise.
