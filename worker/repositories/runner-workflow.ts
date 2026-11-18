// Reviewed agent revision; customer CI does not execute a moving platform branch.
export { REVIEWED_RUNNER_REVISION as DEFAULT_RUNNER_REF } from "../../shared/repository/runner-version";
export function runnerWorkflow(origin: string, runnerRef: string) {
  return `name: Traceyard
run-name: Traceyard \${{ inputs.run_request }}
on:
  workflow_dispatch:
    inputs:
      run_request:
        description: Traceyard check request
        required: true
        type: string
permissions:
  contents: read
  id-token: write
concurrency:
  group: traceyard-\${{ github.repository_id }}
  cancel-in-progress: false
jobs:
  inspect:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false
          fetch-depth: 0
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
          cache: 'npm'
          cache-dependency-path: \${{ hashFiles('package-lock.json') != '' && 'package-lock.json' || '**/package-lock.json' }}
      - name: Install runner dependencies
        run: npm ci --prefix .traceyard-runner/runner/package --omit=dev --ignore-scripts --no-audit --no-fund
      - name: Prepare trusted runner
        run: node .traceyard-runner/runner/prepare.mjs
      - name: Discover, build and test
        env:
          CI: 'true'
          NPM_CONFIG_AUDIT: 'false'
          NPM_CONFIG_FUND: 'false'
          NPM_CONFIG_FETCH_TIMEOUT: '30000'
          NPM_CONFIG_FETCH_RETRIES: '1'
          WRANGLER_SEND_METRICS: 'false'
          WRANGLER_SEND_ERROR_REPORTS: 'false'
          TRACEYARD_ORIGIN: ${JSON.stringify(origin)}
          TRACEYARD_RUN_REQUEST: \${{ inputs.run_request }}
        run: node .traceyard-runner/runner/package/agent/cli.mjs run .
`;
}
