export function runnerWorkflow(origin: string, branch: string, runnerRef: string) {
  // JSON strings are valid YAML scalars; never interpolate repository text as shell code.
  return `name: Traceyard
on:
  workflow_dispatch:
    inputs:
      run_request:
        description: Saved check request
        required: false
        type: string
  push:
    branches: [${JSON.stringify(branch)}]
    paths: [".github/workflows/traceyard.yml"]
permissions:
  contents: read
  id-token: write
concurrency:
  group: traceyard-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  inspect:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false
      - name: Fetch Traceyard runner
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          repository: fysaio/traceyard
          ref: ${runnerRef}
          path: .traceyard-runner
          persist-credentials: false
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: '22'
          cache: npm
          cache-dependency-path: |
            package-lock.json
            .traceyard-runner/package-lock.json
      - name: Install runner dependencies
        run: npm ci --prefix .traceyard-runner --omit=dev --ignore-scripts --no-audit --no-fund
      - name: Discover, build and test
        env:
          TRACEYARD_ORIGIN: ${JSON.stringify(origin)}
          TRACEYARD_RUN_REQUEST: \${{ inputs.run_request }}
        run: node .traceyard-runner/agent/cli.mjs run .
`;
}
