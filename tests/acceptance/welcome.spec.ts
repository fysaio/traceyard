import { expect, test } from "@playwright/test";

test("an anonymous visitor can inspect the landing page and find sign-in at every width", async ({
  page,
}, testInfo) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { data: { user: null, sessions: [], githubSignInAvailable: true } },
    }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const headline = page.getByRole("heading", { name: "Make every change explain itself." });
  await expect(headline).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "One calm interface for humans, agents, and CI." }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => null));
  const signIn = page.getByRole("main").getByRole("link", { name: "Start with GitHub" }).first();
  await expect(signIn).toHaveAttribute("href", "/api/auth/github/start");

  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(signIn).toBeVisible();
    expect(
      await signIn.evaluate((link) => link.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const path = testInfo.outputPath(`welcome-${width}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`welcome-${width}`, { path, contentType: "image/png" });
  }
});
