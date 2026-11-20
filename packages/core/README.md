# @traceyard/core

The local test engine. It runs one test file, optionally at an exact commit, and returns a structured result. It needs no server, no account and no network.

```js
import { runLocalTest } from "@traceyard/core";

const before = await runLocalTest({ repo: ".", commit: "ff70f48", testPath: "src/sum.test.ts" });
// before.status === "FAILED", before.failures[0].message holds the assertion
```

- **Runners:** Vitest, Jest and Pytest, behind one adapter interface (`src/runners.mjs`).
- **Package managers:** npm, pnpm, Yarn and Bun, detected from `packageManager` or the lockfile (`src/package-manager.mjs`).
- **Exact commits:** each run at a SHA happens in a throwaway `git worktree`, so your working tree and index are never touched. Missing commits are fetched only when you pass `fetch: true` (`src/worktree.mjs`).
- **Installs:** core never installs dependencies by itself. `installCommand()` returns the lockfile-exact, scripts-off command for the caller to run.

The hosted runner (`agent/cli.mjs`) and the upcoming `traceyard` CLI are thin layers over this package. Recorded replays need Docker, so they are passed in by the hosted runner and are blocked otherwise.
