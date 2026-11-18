import { expect, test } from "@playwright/test";

test("an anonymous visitor can explore the example and find sign-in at every width", async ({
  page,
}, testInfo) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { data: { user: null, sessions: [], githubSignInAvailable: true } },
    }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Find what broke.*Prove it’s fixed/ }),
  ).toBeVisible();
  const signIn = page.getByRole("link", { name: "Continue with GitHub" });
  await expect(signIn).toHaveAttribute("href", "/api/auth/github/start");
  const example = page.getByRole("region", { name: "Why does checkout fail on retry?" });
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
  await page.getByRole("link", { name: "See an example" }).click();
  await expect(page).toHaveURL(/#investigation-example$/);
  await expect(example).toContainText("1 failed");
  const repaired = example.getByRole("button", { name: "After the fix" });
  await repaired.focus();
  await expect(repaired).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(repaired).toHaveAttribute("aria-pressed", "true");
  await expect(example).toContainText("1 passed");
  await expect(example).toContainText("The test itself was unchanged.");
  await example.getByRole("button", { name: "Original failure" }).click();
  await expect(example).toContainText("1 failed");
});
