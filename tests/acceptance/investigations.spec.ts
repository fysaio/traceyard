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
const execution = {
  status: "FAILED",
  commit: snapshot.commit,
  command: { directory: ".", script: "test", testPath: "tests/checkout.test.ts" },
  counts: { passed: 4, failed: 1, skipped: 0 },
  durationMs: 1200,
  exitCode: 1,
  failures: [
    {
      file: "tests/checkout.test.ts",
      name: "checkout retries",
      message: "Expected 42, received 41",
    },
  ],
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
  execution,
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
      expect(body.testPath).toBe(execution.command.testPath);
      expect(body.commit).toBe(snapshot.commit);
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
  await page.route("**/api/projects/prj_browser/repository/setup", (r) =>
    r.fulfill(json({ state: "READY" })),
  );
  await page.route("**/api/projects/prj_browser/agent-connections", (r) =>
    r.fulfill(json({ items: [] })),
  );
  await page.route("**/api/projects/prj_browser/investigations/ci-revision", (r) =>
    r.fulfill(
      json({
        commit: snapshot.commit,
        kind: "PR merge commit",
        jobUrl: "https://github.com/example/app/actions/runs/10/job/20",
      }),
    ),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Reproduce a failing test" })).toBeVisible();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByLabel("Test file").fill(execution.command.testPath);
  await page
    .getByLabel("GitHub Actions link (optional)")
    .fill("https://github.com/example/app/actions/runs/10/job/20");
  await page.getByRole("button", { name: "Use tested commit" }).click();
  await expect(page.getByLabel("Failing commit")).toHaveValue(snapshot.commit);
  await expect(page.getByText(/PR merge commit from the/)).toBeVisible();
  await page.getByRole("button", { name: "Run failing test", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What we found" })).toBeVisible();
  await expect(page).toHaveURL(/investigations\/inv_browser\?project=prj_browser/);
  await page.getByRole("button", { name: /Focused test execution/ }).click();
  await expect(
    page.locator(".evidence-reader").getByText("Expected 42, received 41"),
  ).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Reproduce a failing test" })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Investigation result" })).toBeVisible();
  await expect(
    page.getByText("Inspect retained repository evidence", { exact: true }),
  ).toBeHidden();
  await page.getByText("Original question", { exact: true }).click();
  await expect(
    page.getByText("Inspect retained repository evidence", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "← Investigations" }).click();
  await expect(
    page.getByText("Inspect retained repository evidence", { exact: true }),
  ).toBeVisible();
});

test("reopening a baseline restores its repair verdict and readable execution evidence", async ({
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
  await page.route("**/api/projects/prj_browser/investigations/inv_browser", (r) =>
    r.fulfill(
      json({
        ...inv,
        execution: {
          status: "FAILED",
          commit: snapshot.commit,
          command: { directory: ".", script: "test", testPath: "tests/checkout.test.ts" },
          counts: { passed: 4, failed: 1, skipped: 0 },
          durationMs: 1200,
          exitCode: 1,
          failures: [
            {
              file: "tests/checkout.test.ts",
              name: "checkout retries",
              message: "Expected 42, received 41",
            },
          ],
        },
        verifications: [
          {
            id: "ver_browser",
            baselineId: inv.id,
            candidateId: "inv_candidate",
            candidateCommit: "b".repeat(40),
            createdAt: "2026-11-18",
          },
        ],
      }),
    ),
  );
  await page.route("**/api/projects/prj_browser/verifications/ver_browser", (r) =>
    r.fulfill(
      json({
        id: "ver_browser",
        baselineId: inv.id,
        candidateId: "inv_candidate",
        candidateCommit: "b".repeat(40),
        verdict: "PASSED",
        label: "Confirmed",
        baselineRun: {
          commit: snapshot.commit,
          testPath: execution.command.testPath,
          status: "FAILED",
          evidenceId: "evd_browser",
          failure: execution.failures[0],
        },
        candidateRun: {
          commit: "b".repeat(40),
          testPath: execution.command.testPath,
          status: "SUCCEEDED",
          evidenceId: "evd_candidate",
          failure: null,
        },
        changedTests: [],
        limitations: ["Only the selected checks executed."],
        summary: "The retained reproducer passes against the candidate.",
        metrics: {},
      }),
    ),
  );
  await page.goto("/investigations/inv_browser?project=prj_browser");
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Test execution result" })).toContainText(
    "tests/checkout.test.ts",
  );
  await expect(
    page
      .getByRole("region", { name: "Test execution result" })
      .getByText("Expected 42, received 41", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open candidate evidence" })).toHaveAttribute(
    "href",
    "/investigations/inv_candidate?project=prj_browser&evidence=evd_candidate#retained-evidence",
  );
  await page.reload();
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test("incomplete execution setup blocks test launch while source analysis remains available", async ({
  page,
}) => {
  await page.route("**/api/auth/session", (r) =>
    r.fulfill(
      json({
        user: { id: "usr_browser", login: "browser", name: "Browser" },
        sessions: [],
        githubSignInAvailable: true,
      }),
    ),
  );
  await page.route("**/api/projects", (r) =>
    r.fulfill(json({ items: [{ id: "prj_browser", name: "Browser", repository: "example/app" }] })),
  );
  await page.route("**/api/projects/prj_browser/catalog", (r) =>
    r.fulfill(
      json({
        executionAvailable: true,
        executionProvider: "github",
        repository: { runner_enabled: 0 },
      }),
    ),
  );
  let setupWrites = 0;
  const preview = {
    state: "SETUP_REQUIRED",
    defaultBranch: "main",
    previousWorkflow: "name: Old workflow",
    workflow: "name: Reviewed workflow",
    previewKey: "a".repeat(64),
  };
  await page.route("**/api/projects/prj_browser/repository/setup", (r) => {
    if (r.request().method() === "POST") {
      expect(r.request().postDataJSON()).toEqual({ previewKey: preview.previewKey });
      setupWrites++;
    }
    return r.fulfill(
      json(
        setupWrites
          ? { state: "AWAITING_MERGE", prUrl: "https://github.com/example/app/pull/1" }
          : preview,
      ),
    );
  });
  await page.route("**/api/projects/prj_browser/repository/index?kind=tests", (r) =>
    r.fulfill(json(null)),
  );
  await page.route("**/api/projects/prj_browser/investigations", (r) => {
    if (r.request().method() === "POST") {
      expect(r.request().postDataJSON()).toMatchObject({
        mode: "analyze",
        expectedRepository: "example/app",
        captureInteractions: false,
      });
      return r.fulfill(json(inv));
    }
    return r.fulfill(json({ items: [] }));
  });
  await page.route("**/api/projects/prj_browser/investigations/inv_browser", (r) =>
    r.fulfill(json(inv)),
  );
  await page.goto("/investigations?project=prj_browser");
  await expect(page.getByRole("button", { name: "Run failing test", exact: true })).toBeDisabled();
  await expect(page.getByText("GitHub workflow needs an update", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review workflow change" }).click();
  const dialog = page.getByRole("dialog", { name: "Review GitHub workflow setup" });
  await expect(dialog.getByText("name: Reviewed workflow")).toBeVisible();
  expect(setupWrites).toBe(0);
  await dialog.getByRole("button", { name: "Create setup PR" }).click();
  await expect(dialog.getByRole("link", { name: "Open setup PR on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/example/app/pull/1",
  );
  expect(setupWrites).toBe(1);
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.getByRole("button", { name: "Inspect evidence", exact: true }).click();
  await page.getByLabel("What should Traceyard inspect?").fill(inv.question);
  await expect(page.getByRole("button", { name: "Investigate", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Investigate", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What we found" })).toBeVisible();
});

test("workspace tools keep workflow runs distinct and preserve the selected project", async ({
  page,
}) => {
  await page.route("**/api/auth/session", (r) =>
    r.fulfill(
      json({
        user: { id: "usr_browser", login: "browser", name: "Browser" },
        sessions: [],
        githubSignInAvailable: true,
      }),
    ),
  );
  await page.route("**/api/projects", (r) =>
    r.fulfill(json({ items: [{ id: "prj_browser", name: "Browser", repository: "example/app" }] })),
  );
  await page.route("**/api/projects/prj_browser/catalog", (r) =>
    r.fulfill(json({ executionAvailable: true, executionProvider: "github" })),
  );
  await page.route("**/api/projects/prj_browser/investigations", (r) =>
    r.fulfill(json({ items: [] })),
  );
  await page.route("**/api/projects/prj_browser/repository/index?kind=tests", (r) =>
    r.fulfill(json(null)),
  );
  await page.route("**/api/runs?*", (r) => r.fulfill(json({ items: [], nextCursor: null })));
  await page.goto("/investigations?project=prj_browser");
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("link", { name: /Workflow runs/ }).click();
  await expect(page).toHaveURL(/executions\?project=prj_browser/);
  await expect(page.getByRole("heading", { name: "Workflow runs", exact: true })).toBeVisible();
  await expect(page.getByText(/Repository test results live in Investigations/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Repository test investigations" })).toHaveAttribute(
    "href",
    "/investigations?project=prj_browser",
  );
});

test("a new account can open agent setup before choosing a repository", async ({ page }) => {
  await page.route("**/api/auth/session", (r) =>
    r.fulfill(
      json({
        user: { id: "usr_browser", login: "browser", name: "Browser" },
        sessions: [],
        githubSignInAvailable: true,
      }),
    ),
  );
  await page.route("**/api/projects", (r) => r.fulfill(json({ items: [] })));
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start with your repository" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("link", { name: "Agent setup" }).click();
  await expect(page.getByRole("heading", { name: "Connect a coding agent" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy MCP URL" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage agent access" })).toHaveAttribute(
    "href",
    "/oauth/connections",
  );
  await expect(page.getByRole("button", { name: "Connect repository" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a regular local user can open every workspace destination on desktop and mobile", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/__acceptance/account");
  await page.getByRole("button", { name: "Open local test account" }).click();
  await expect(page.getByRole("heading", { name: "Reproduce a failing test" })).toBeVisible();
  const routes = [
    "investigations",
    "connections",
    "projects",
    "workflows",
    "executions",
    "traces",
    "approvals",
    "gateway",
    "laboratory",
    "connect",
    "settings/account",
    "settings/projects",
    "settings/appearance",
    "settings/developer",
    "settings/automations",
  ];
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    for (const route of routes) {
      await page.goto("/" + route);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("status")).toHaveCount(0);
      if (route === "approvals") {
        await expect(page.getByRole("link", { name: "Open workflows" })).toHaveAttribute(
          "href",
          /^\/workflows\b/,
        );
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${route} at ${width}px`,
      ).toBe(true);
      const path = testInfo.outputPath(`${route.replaceAll("/", "-")}-${width}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`${route}-${width}`, { path, contentType: "image/png" });
    }
  }
  expect(errors).toEqual([]);
});

test("a user creates a template workflow, publishes it, runs real input and reopens its persisted output", async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  await page.goto("/__acceptance/account");
  await page.getByRole("button", { name: "Open local test account" }).click();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("link", { name: /^Workflows/ }).click();
  await page.getByRole("tab", { name: "Templates", exact: true }).click();
  await page.getByRole("link", { name: /Parallel processing/ }).click();
  await expect(
    page.getByRole("heading", { name: "Parallel processing", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Templates", exact: true }).click();
  await expect(page).toHaveURL(/workflows\?tab=templates/);
  await page.getByRole("link", { name: /Parallel processing/ }).click();
  await page.getByRole("button", { name: "Use template", exact: true }).click();
  await page.getByRole("button", { name: "Publish version", exact: true }).click();
  await page.getByRole("button", { name: "Run v1", exact: true }).click();
  await page.getByLabel("JSON input", { exact: true }).fill(
    JSON.stringify({
      customer: { name: "Acceptance customer" },
      order: { id: "order-acceptance", total: 42 },
    }),
  );
  await page.getByRole("button", { name: "Start execution", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Output is ready", exact: true })).toBeVisible({
    timeout: 30000,
  });
  const output = page.locator(".result-output > pre");
  await expect(output).toContainText("Acceptance customer");
  await expect(output).toContainText("order-acceptance");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Output is ready", exact: true })).toBeVisible();
  await expect(output).toContainText("order-acceptance");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const path = testInfo.outputPath(`persisted-workflow-result-${width}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`persisted-workflow-result-${width}`, { path, contentType: "image/png" });
  }
});
