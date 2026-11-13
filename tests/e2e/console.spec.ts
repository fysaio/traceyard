import { expect, test, type Page } from "@playwright/test";

const EXAMPLE_DOCUMENT =
  "Incident review: dispatch latency\n\nAt 09:12 UTC the execution queue exceeded its polling budget and delayed workflow dispatch by four minutes. The on-call engineer drained the backlog and replayed the affected executions. No data was lost.";

async function launch(
  page: Page,
  options: { title: string; scenario?: "success" | "terminal_failure" },
): Promise<string> {
  await page.getByRole("button", { name: "Launch run" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Launch a sandbox execution" });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Title").fill(options.title);
  await dialog.getByLabel("Document").fill(EXAMPLE_DOCUMENT);
  if (options.scenario !== undefined) {
    await dialog.getByLabel("Fault scenario").selectOption(options.scenario);
  }
  await dialog.getByRole("button", { name: "Launch run" }).click();

  await expect(page).toHaveURL(/\/executions\/run_[a-f0-9]+$/u);
  const match = /\/executions\/(run_[a-f0-9]+)$/u.exec(new URL(page.url()).pathname);
  if (match === null) throw new Error(`Could not parse run id from ${page.url()}`);
  return match[1]!;
}

test("a fresh anonymous session starts with an honest empty state", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByText("No executions yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Launch first run" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Execution volume" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Failure classes" })).toHaveCount(0);

  await expect(page.getByText("20 runs per session each day")).toBeVisible();
  await expect(page.getByText(/daily runs used/u)).toBeVisible();
});

test("launching a run persists a real execution with steps, events and output", async ({
  page,
}) => {
  await page.goto("/");
  const runId = await launch(page, { title: "E2E queue saturation review" });

  await expect(page.getByText(runId, { exact: true })).toBeVisible();
  await expect(page.getByText("E2E queue saturation review")).toBeVisible();

  // Real Workflow execution: the run reaches a terminal success state.
  await expect(page.getByText("SUCCEEDED", { exact: true }).first()).toBeVisible({
    timeout: 45_000,
  });

  await expect(page.getByRole("heading", { name: "Step timeline" })).toBeVisible();
  for (const step of [
    "Validate input",
    "Normalize content",
    "Extract insights",
    "Validate output",
    "Commit result",
  ]) {
    await expect(page.getByText(step, { exact: true })).toBeVisible();
  }

  // Expanding a checkpoint reveals the persisted step key and attempt evidence.
  const extract = page.locator("details").filter({ hasText: "Extract insights" });
  await extract.locator("summary").click();
  await expect(extract.getByText("key: extract-insights")).toBeVisible();
  await expect(extract.getByText("#1", { exact: true })).toBeVisible();

  // Comitted output and product events come from D1, not client state.
  await expect(page.getByRole("heading", { name: "Event stream" })).toBeVisible();
  await expect(page.getByText("Committed output")).toBeVisible();
  await expect(page.getByText("run.succeeded")).toBeVisible();
});

test("a terminal failure is surfaced with a real retry lineage", async ({ page }) => {
  await page.goto("/");
  const originalRunId = await launch(page, {
    title: "E2E terminal failure",
    scenario: "terminal_failure",
  });

  await expect(page.getByText("FAILED", { exact: true }).first()).toBeVisible({
    timeout: 45_000,
  });
  await expect(
    page.getByText("Simulated permanent extraction failure", { exact: false }).first(),
  ).toBeVisible();

  const originalUrl = page.url();
  await page.getByRole("button", { name: "Retry run" }).click();
  await expect(page).not.toHaveURL(originalUrl);
  await expect(page).toHaveURL(/\/executions\/run_[a-f0-9]+$/u);
  expect(page.url()).not.toContain(originalRunId);

  await expect(
    page.getByText(`retry of ${originalRunId.slice(0, 12)}`, { exact: false }),
  ).toBeVisible();
});

test("primary navigation reaches every documented surface", async ({ page }) => {
  await page.goto("/");

  const destinations = [
    { link: "Executions", heading: "Execution ledger" },
    { link: "Workflows", heading: "Workflows" },
    { link: "Analytics", heading: "Reliability analytics" },
    { link: "Overview", heading: "Overview" },
    { link: "Settings", heading: "Settings & runtime" },
  ] as const;

  for (const destination of destinations) {
    await page.getByRole("link", { name: destination.link, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: destination.heading })).toBeVisible();
  }

  await expect(page.getByText("D1 is the system of record")).toBeVisible();
});
