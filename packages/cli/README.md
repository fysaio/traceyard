# traceyard CLI

`repro`, `check`, `verify` and `receipt` on your own machine. A thin layer over [`@traceyard/core`](../core). Full reference: [docs/CLI.md](../../docs/CLI.md).

```bash
node packages/cli/bin/traceyard.mjs repro src/cart.test.ts --at 3f2c9e1
```

- `src/main.mjs`: argument parsing, commands and output.
- `src/run.mjs`: runs one test at a commit or in the working tree, prepares dependencies, caches results.
- `src/verdicts.mjs`: verdict rules and exit codes.
- `src/receipt.mjs`: receipt files and their digest.
- `src/github.mjs`: reads the tested commit and failing tests from a GitHub Actions job.

The CLI imports core by relative path for now. Packaging it as `npx traceyard` is #49.
