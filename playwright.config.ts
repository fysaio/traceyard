import { existsSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;

const CHROME_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);

// Prefer a branded Chrome installation when the Playwright browser bundle has
// not been downloaded (for example in an offline environment). CI runners
// without Chrome fall back to the managed Chromium binary.
const channel = CHROME_CANDIDATES.some((candidate) => existsSync(candidate))
  ? ("chrome" as const)
  : undefined;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI === undefined ? 0 : 1,
  workers: 1,
  reporter: process.env.CI === undefined ? "list" : "github",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel },
    },
  ],
  webServer: {
    // Apply local migrations first so the dev server always starts against the
    // current schema. `reuseExistingServer` keeps watch-mode runs fast locally.
    command: "npm run db:migrate:local && npm run dev",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: process.env.CI === undefined,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
