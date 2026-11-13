import { expect, test, type Page } from "@playwright/test";

const user = {
  id: "usr_e2e",
  login: "traceyard-developer",
  name: "Traceyard Developer",
  avatarUrl: null,
};

function jsonResponse(data: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify({ data, meta: { requestId: "e2e" } }),
  };
}

async function mockAuthenticatedSession(
  page: Page,
  sessions: Array<{ id: string; createdAt: string; lastSeenAt: string; current: boolean }>,
) {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill(
      jsonResponse({
        user,
        currentSessionId: "ses_current",
        githubSignInAvailable: true,
        sessions,
      }),
    ),
  );
}

test("authenticated developers can create projects and save non-executable definitions", async ({
  page,
}) => {
  const projects = [
    {
      id: "prj_personal",
      slug: "workspace-personal",
      name: "Personal workspace",
      createdAt: new Date().toISOString(),
    },
  ];
  const savedWorkflows: Array<{
    id: string;
    projectId: string;
    slug: string;
    name: string;
    description: string;
    definition: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }> = [];
  const now = new Date().toISOString();

  await mockAuthenticatedSession(page, []);
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON() as { name: string };
      const project = {
        id: "prj_recovery",
        slug: "project-recovery",
        name: request.name,
        createdAt: now,
      };
      projects.push(project);
      await route.fulfill(jsonResponse(project, 201));
      return;
    }
    await route.fulfill(jsonResponse({ items: projects }));
  });
  await page.route("**/api/projects/*/workflows", async (route) => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON() as {
        name: string;
        description: string;
        definition: Record<string, unknown>;
      };
      const projectId = new URL(route.request().url()).pathname.split("/")[3] ?? "";
      const workflow = {
        id: "swd_invoice_recovery",
        projectId,
        slug: "workflow-invoice-recovery",
        ...request,
        createdAt: now,
        updatedAt: now,
      };
      savedWorkflows.push(workflow);
      await route.fulfill(jsonResponse(workflow, 201));
      return;
    }
    await route.fulfill(jsonResponse({ items: savedWorkflows }));
  });

  await page.goto("/workflows");
  await expect(page.getByRole("heading", { name: "Projects & saved definitions" })).toBeVisible();
  await expect(page.getByLabel("Selected project")).toHaveValue("prj_personal");

  await page.getByLabel("New project").fill("Recovery workflows");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByLabel("Selected project")).toHaveValue("prj_recovery");

  await page.getByLabel("Definition name").fill("Invoice recovery");
  await page.getByLabel("Description").fill("Validate, retry, and report an invoice.");
  await page.getByLabel("Definition JSON").fill("{ invalid");
  await page.getByRole("button", { name: "Save definition" }).click();
  await expect(page.getByRole("alert").getByText("Enter a valid JSON object.")).toBeVisible();

  await page.getByLabel("Definition JSON").fill('{"nodes":[{"id":"validate"}],"edges":[]}');
  await page.getByRole("button", { name: "Save definition" }).click();
  await expect(page.getByText("Invoice recovery")).toBeVisible();
  await expect(page.getByText("Validate, retry, and report an invoice.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run workflow" })).toHaveCount(1);
});

test("account settings allow a user to revoke another sign-in session", async ({ page }) => {
  let sessions = [
    {
      id: "ses_current",
      createdAt: "2025-01-01T10:00:00.000Z",
      lastSeenAt: "2025-01-02T10:00:00.000Z",
      current: true,
    },
    {
      id: "ses_remote",
      createdAt: "2025-01-01T10:00:00.000Z",
      lastSeenAt: "2025-01-02T10:00:00.000Z",
      current: false,
    },
  ];

  await page.route("**/api/auth/session", (route) =>
    route.fulfill(
      jsonResponse({
        user,
        currentSessionId: "ses_current",
        githubSignInAvailable: true,
        sessions,
      }),
    ),
  );
  await page.route("**/api/auth/sessions/ses_remote/revoke", async (route) => {
    sessions = sessions.filter((session) => session.id !== "ses_remote");
    await route.fulfill(jsonResponse({ revoked: true }));
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Sign-in sessions" })).toBeVisible();
  await expect(page.getByText("Signed-in device")).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Revoke session" }).click();
  await expect(page.getByText("Signed-in device")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out this device" })).toBeVisible();
});
