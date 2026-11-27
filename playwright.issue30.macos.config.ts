import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/acceptance",
  grep: /issue #30: keyboard-only composer, evidence and repair flow/,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    browserName: "webkit",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Safari"],
  },
  webServer: {
    command: "npm run dev:acceptance",
    url: "http://localhost:5173/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
