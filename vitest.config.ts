import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Two projects keep the fast, pure-domain tests independent from the Worker
 * runtime:
 *
 * - `unit` runs in Node and exercises the state machine, parsing and
 *   deterministic workflow maths.
 * - `integration` boots the real Worker in Miniflare with D1, the queue and
 *   Workflows bindings, applying the same migrations as production.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  return {
    test: {
      projects: [
        {
          test: {
            name: "unit",
            environment: "node",
            include: ["tests/unit/**/*.test.ts"],
          },
        },
        {
          plugins: [
            cloudflareTest({
              // Resolve local-variable files beside the test config, never the operator config.
              wrangler: { configPath: "./tests/wrangler.jsonc" },
              remoteBindings: false,
              miniflare: {
                bindings: {
                  // Explicit bindings also override operator process environment variables.
                  APP_VERSION: "0.1.0",
                  SOURCE_SCAN_FILE_LIMIT: "16",
                  SOURCE_SCAN_FILE_BYTES: "16000",
                  TEST_MODE: "true",
                  TEST_MIGRATIONS: migrations,
                  GITHUB_CLIENT_ID: "traceyard-test-client",
                  GITHUB_CLIENT_SECRET: "test-only-not-a-github-secret",
                  PUBLIC_APP_ORIGIN: "https://traceyard.test",
                },
              },
            }),
          ],
          test: {
            name: "integration",
            include: ["tests/integration/**/*.test.ts"],
            setupFiles: ["./tests/integration/setup.ts"],
            testTimeout: 60_000,
            hookTimeout: 60_000,
          },
        },
      ],
    },
  };
});
