import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /**
       * Migrations loaded from `migrations/` by vitest.config.ts and applied to
       * the isolated D1 database before each integration test file.
       */
      TEST_MIGRATIONS: D1Migration[];
      TEST_MODE: string;
    }
  }
}

export {};
