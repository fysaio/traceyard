# traceyard CLI

The `traceyard` CLI provides core verification commands (`repro`, `check`, `verify`, and `receipt`) plus `guard`, `explain`, `inspect`, and the local `mcp` server. It is a thin layer over [`@traceyard/core`](../core). See the [full CLI and MCP reference](../../docs/CLI.md).

Released versions are available with `npx traceyard@<version>`; the current release is `0.1.0`. For repository development, from the repository root with Node.js 22.12.0 or newer:

```bash
npm ci
node packages/cli/bin/traceyard.mjs repro src/cart.test.ts --at <failing-sha>
```

- `src/main.mjs`: argument parsing, commands, and output.
- `src/run.mjs`: runs one test at a commit or in the working tree, prepares dependencies, and caches results.
- `src/verdicts.mjs`: verdict rules and exit codes.
- `src/receipt.mjs`: receipt files and their digest.
- `src/github.mjs`: reads the tested commit and failing tests from a GitHub Actions job.

Release and package publication details are in [RELEASING.md](../../docs/RELEASING.md).
