import { expect, test } from "@playwright/test";

// UI contract tests stub session/catalog responses only. Real OAuth state,
// session ownership, D1 writes and queue execution are integration-tested.
const json = (data: unknown) => ({
  contentType: "application/json",
  body: JSON.stringify({ data, meta: { requestId: "ui-contract" } }),
});
test("list and grid selection keep action controls within their cards", async ({ page }) => {
  await page.route("**/api/auth/session", (r) =>
    r.fulfill(
      json({
        user: { id: "usr_contract", login: "contract", name: "Contract", avatarUrl: null },
        currentSessionId: "ses_contract",
        githubSignInAvailable: true,
        sessions: [],
      }),
    ),
  );
  await page.route("**/api/projects", (r) =>
    r.fulfill(
      json({
        items: [
          {
            id: "prj_contract",
            name: "Main project",
            slug: "main",
            createdAt: "2026-11-15T00:00:00Z",
          },
        ],
      }),
    ),
  );
  await page.route("**/api/projects/*/workflows", (r) => r.fulfill(json({ items: [] })));
  await page.route("**/api/workflows?*", (r) =>
    r.fulfill(
      json({
        items: [
          {
            id: "wf_document_intelligence",
            name: "Document intelligence",
            slug: "document-intelligence",
            description: "Validate, extract and persist document results.",
            version: 1,
            createdAt: "2026-11-15T00:00:00Z",
            steps: [],
          },
        ],
      }),
    ),
  );
  await page.route("**/api/projects/*/studio", (r) =>
    r.fulfill(
      json({
        items: [
          {
            id: "wf_document_intelligence",
            name: "Document intelligence",
            description: "Validate, extract and persist document results.",
            icon: "file-lines",
            revision: 1,
            current_version: 1,
          },
        ],
      }),
    ),
  );
  await page.route("**/api/auth/guest-work", (r) => r.fulfill(json({ executions: 0 })));
  await page.route("**/api/projects/*/instrumented-workflows", (r) =>
    r.fulfill(json({ items: [] })),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toBeVisible();
  for (const width of [390, 768, 1009, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const layout of ["List view", "Grid view"]) {
      await page.getByRole("button", { name: layout }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      const card = page.locator(".saved-workflow").first();
      const box = await card.boundingBox(),
        action = await card.getByRole("button", { name: "Run", exact: true }).boundingBox();
      expect(box).not.toBeNull();
      expect(action).not.toBeNull();
      expect(action!.x + action!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
    }
  }
});
