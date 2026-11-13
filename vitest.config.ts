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
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MODE: "true",
                  TEST_MIGRATIONS: migrations,
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
