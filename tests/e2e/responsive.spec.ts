import { expect, test } from "@playwright/test";
test("the signed-out screen reflows without horizontal scrolling", async ({ page }) => {
  await page.goto("/");
  for (const width of [390, 768, 1009, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByRole("heading", { name: "Execute workflows. Recover when they break." }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
});
