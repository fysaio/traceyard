import { expect, test } from "@playwright/test";

import type { EventListPage, RunDetail } from "../../shared/contracts/api";

const COLOR_TOKENS = [
  "--canvas",
  "--surface",
  "--raised",
  "--line",
  "--line-strong",
  "--ink",
  "--muted",
  "--faint",
  "--accent",
  "--accent-strong",
  "--accent-ink",
  "--danger",
  "--warning",
  "--info",
  "--chart-grid",
  "--chart-muted",
  "--chart-succeeded",
  "--chart-failed",
  "--chart-cancelled",
  "--chart-active",
];

function isGrayscale(color: string): boolean {
  const hex = /^#([0-9a-f]{6})$/iu.exec(color)?.[1];
  if (hex === undefined) return false;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return Math.max(red, green, blue) - Math.min(red, green, blue) <= 8;
}

test("theme preference persists and principal screens remain monochrome and usable on mobile", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Switch to dark theme" }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const colors = await page.evaluate((names) => {
    const style = getComputedStyle(document.documentElement);
    return names.map((name) => style.getPropertyValue(name).trim());
  }, COLOR_TOKENS);
  expect(colors).toHaveLength(COLOR_TOKENS.length);
  expect(colors.every(isGrayscale)).toBe(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light theme" }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  const run: RunDetail = {
    id: "run_e2e",
    workflow: {
      id: "wf_document_intelligence",
      slug: "document-intelligence",
      name: "Document Intelligence",
      version: 1,
    },
    status: "SUCCEEDED",
    triggerSource: "sandbox",
    scenario: "success",
    createdAt: "2025-01-02T10:00:00.000Z",
    startedAt: "2025-01-02T10:00:01.000Z",
    completedAt: "2025-01-02T10:00:02.000Z",
    durationMs: 1000,
    queueDelayMs: 100,
    stepCounts: {
      total: 1,
      pending: 0,
      running: 0,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      cancelled: 0,
    },
    error: null,
    parentRunId: null,
    retryOfRunId: null,
    input: { title: "Responsive inspection", document: "Test-only UI fixture." },
    output: { summary: "Persisted fixture output." },
    correlationId: "correlation_e2e",
    cancelRequestedAt: null,
    retryRunId: null,
    dispatch: {
      status: "CLAIMED",
      attempts: 1,
      lastError: null,
      publishedAt: "2025-01-02T10:00:00.500Z",
      claimedAt: "2025-01-02T10:00:00.750Z",
    },
    steps: [
      {
        id: "step_e2e",
        key: "validate",
        name: "Validate input",
        ordinal: 1,
        status: "SUCCEEDED",
        attemptCount: 1,
        maxAttempts: 1,
        startedAt: "2025-01-02T10:00:01.000Z",
        completedAt: "2025-01-02T10:00:02.000Z",
        durationMs: 1000,
        input: { title: "Responsive inspection" },
        output: { valid: true },
        error: null,
        attempts: [
          {
            number: 1,
            status: "SUCCEEDED",
            startedAt: "2025-01-02T10:00:01.000Z",
            completedAt: "2025-01-02T10:00:02.000Z",
            durationMs: 1000,
            error: null,
          },
        ],
      },
    ],
  };
  const events: EventListPage = { items: [], nextCursor: null };
  await page.route("**/api/runs/run_e2e/events**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: events, meta: { requestId: "e2e" } }),
    }),
  );
  await page.route("**/api/runs/run_e2e", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: run, meta: { requestId: "e2e" } }),
    }),
  );
  await page.goto("/executions/run_e2e");
  await expect(page.getByRole("heading", { name: "Step timeline" })).toBeVisible({
    timeout: 15_000,
  });

  await page.setViewportSize({ width: 375, height: 812 });
  const routes = [
    page.url(),
    new URL("/executions", page.url()).toString(),
    new URL("/workflows", page.url()).toString(),
    new URL("/analytics", page.url()).toString(),
    new URL("/settings", page.url()).toString(),
    new URL("/", page.url()).toString(),
  ];

  for (const route of routes) {
    await page.goto(route);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `Horizontal overflow on ${new URL(route).pathname}`).toBeLessThanOrEqual(1);
    await expect(page.locator("svg")).toHaveCount(0);
    if (new URL(route).pathname === "/") {
      const clippedNavigationLink = await page
        .locator('header nav[aria-label="Primary navigation"]')
        .evaluate((navigation) => {
          const rightEdge = navigation.getBoundingClientRect().right;
          return Array.from(navigation.querySelectorAll("a")).some(
            (link) => link.getBoundingClientRect().right > rightEdge + 1,
          );
        });
      expect(clippedNavigationLink).toBe(false);
    }
  }
});
