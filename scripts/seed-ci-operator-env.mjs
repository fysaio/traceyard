// Regression fixture for local release commands. Never overwrite an operator's files.
import { writeFile } from "node:fs/promises";
if (process.env.CI !== "true") throw Error("This fixture is for clean CI checkouts only.");
await writeFile(
  new URL("../.dev.vars", import.meta.url),
  [
    'APP_VERSION="operator-version"',
    'SOURCE_SCAN_FILE_LIMIT="1"',
    'GITHUB_APP_ID="999"',
    'GITHUB_APP_SLUG="ci-operator-fixture"',
    'GITHUB_APP_PRIVATE_KEY="test-only-invalid-key"',
    'GITHUB_APP_WEBHOOK_SECRET="test-only-operator-secret"',
    'TRACEYARD_RUNNER_REF="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    'PUBLIC_APP_ORIGIN="https://operator.example.test"',
    'OPERATOR_ONLY_SENTINEL="must-not-reach-tests"',
    "",
  ].join("\n"),
  { flag: "wx", mode: 0o600 },
);
await writeFile(
  new URL("../.env", import.meta.url),
  'OPERATOR_DOT_ENV_SENTINEL="must-not-reach-tests"\n',
  { flag: "wx", mode: 0o600 },
);
console.log("Created synthetic operator settings to test release environment isolation.");
