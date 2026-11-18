import { test, expect } from "@playwright/test";
const json = (data: unknown) => ({
  contentType: "application/json",
  body: JSON.stringify({ data, meta: { requestId: "browser-contract" } }),
});
const snapshot = {
  repository: "example/app",
  commit: "a".repeat(40),
  filesScanned: 4,
  warnings: [],
};
const inv = {
  id: "inv_browser",
  projectId: "prj_browser",
  question: "Why does checkout retry fail?",
  status: "EVIDENCE_READY",
  snapshot,
  finding: {
    summary: "The retained checkout assertion failed.",
    basis: "observed",
    limitations: ["Only the selected test executed."],
    nextAction: "Repair the relevant code and verify the candidate.",
  },
  evidence: [
    {
      id: "evd_browser",
      kind: "diagnostic",
      basis: "observed",
      title: "Focused test execution",
      truncated: false,
    },
  ],
  attempts: [
    {
      id: "iat_browser",
      requestId: "req_browser",
      status: "FAILED",
      checkId: null,
      createdAt: "2026-11-18",
    },
  ],
  recordings: [],
  browserPath: "/investigations/inv_browser?project=prj_browser",
  budget: { outputChars: 3000, returnedChars: 1000, truncated: false },
};
test("connected developer investigates, inspects bounded evidence and opens agent connections", async ({
  page,
}) => {
  await page.route("**/api/auth/session", (r) =>
    r.fulfill(
      json({
        user: { id: "usr_browser", login: "browser", name: "Browser", avatarUrl: null },
        sessions: [],
        githubSignInAvailable: true,
      }),
    ),
  );
  await page.route("**/api/projects", (r) =>
    r.fulfill(json({ items: [{ id: "prj_browser", name: "Browser", repository: "example/app" }] })),
  );
  await page.route("**/api/projects/prj_browser/investigations", async (r) => {
    if (r.request().method() === "POST") {
      const body = r.request().postDataJSON();
      expect(body.question).toBe(inv.question);
      expect(body.mode).toBe("execute");
      expect(body.captureInteractions).toBe(false);
      await r.fulfill(json(inv));
    } else await r.fulfill(json({ items: [inv] }));
  });
  await page.route("**/api/projects/prj_browser/investigations/inv_browser", (r) =>
    r.fulfill(json(inv)),
  );
  await page.route(
    "**/api/projects/prj_browser/investigations/inv_browser/evidence/evd_browser?*",
    (r) =>
      r.fulfill(
        json({
          id: "evd_browser",
          text: "Expected 42, received 41",
          offset: 0,
          nextOffset: null,
          truncated: false,
        }),
      ),
  );
  await page.route("**/api/projects/prj_browser/repository/index?kind=tests", (r) =>
    r.fulfill(json(null)),
  );
  await page.route("**/api/projects/prj_browser/catalog", (r) =>
    r.fulfill(json({ executionAvailable: true, executionProvider: "github" })),
  );
  await page.route("**/api/projects/prj_browser/agent-connections", (r) =>
    r.fulfill(json({ items: [] })),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What’s breaking?" })).toBeVisible();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByLabel("Describe the problem").fill(inv.question);
  await page.getByRole("button", { name: "Investigate", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What we found" })).toBeVisible();
  await expect(page).toHaveURL(/investigations\/inv_browser\?project=prj_browser/);
  await page.getByRole("button", { name: /Focused test execution/ }).click();
  await expect(page.getByText("Expected 42, received 41")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next portion" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Verify a repair" })).toBeVisible();
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Use your coding agent" })).toBeVisible();
  await expect(page.getByText("http://localhost:5173/mcp", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("local account opens a real persisted investigation and returns to the same evidence", async ({
  page,
}) => {
  await page.goto("/__acceptance/account");
  await page.getByRole("button", { name: "Open local test account" }).click();
  await expect(page.getByRole("heading", { name: "What’s breaking?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Start with your repository" })).toBeVisible();
  const projects = await (await page.request.get("/api/projects")).json();
  const project = projects.data.items[0];
  expect(project.id).toBeTruthy();
  const response = await page.request.post(`/api/projects/${project.id}/investigations`, {
    data: { question: "Inspect retained repository evidence", mode: "analyze" },
  });
  expect(response.status()).toBe(201);
  const { data } = await response.json();
  await page.goto(data.browserPath);
  await expect(page.getByRole("heading", { name: "What we found" })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Inspect retained repository evidence" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "← Investigations" }).click();
  await expect(
    page.getByText("Inspect retained repository evidence", { exact: true }),
  ).toBeVisible();
});
