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
  const headline = page.getByRole("heading", { name: /Find what broke.*Prove it’s fixed/ });
  await expect(headline).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => null));
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
    expect(
      await headline.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const tops = new Set(
          [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
        );
        return tops.size === 2;
      }),
      `The headline keeps its two lines at ${width}px`,
    ).toBe(true);
    const path = testInfo.outputPath(`welcome-${width}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`welcome-${width}`, { path, contentType: "image/png" });
  }
  await expect(example).toContainText("1 failed");
  const repaired = example.getByRole("button", { name: "After the fix" });
  await repaired.focus();
  await expect(repaired).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(repaired).toHaveAttribute("aria-pressed", "true");
  await expect(example).toContainText("1 passed");
  await expect(example).toContainText("The test file is unchanged.");
  await example.getByRole("button", { name: "Before" }).click();
  await expect(example).toContainText("1 failed");
});
