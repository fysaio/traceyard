import { expect, test } from "@playwright/test";

test("a fresh browser reads the backend auth state and never fabricates a workspace", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Make every change explain itself.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Explore the sandbox" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Workflows & agents", exact: true })).toHaveCount(
    0,
  );
});

test("an unreachable API shows a recoverable error instead of seeded workflows", async ({
  page,
}) => {
  await page.route("**/api/auth/session", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Traceyard is unreachable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});
