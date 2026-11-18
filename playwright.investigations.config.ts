import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
export default defineConfig({
  testDir: "tests/acceptance",
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: existsSync("/usr/bin/chromium")
      ? { executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] }
      : {},
  },
  webServer: {
    command: "npm run dev:acceptance",
    url: "http://localhost:5173/api/health",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
