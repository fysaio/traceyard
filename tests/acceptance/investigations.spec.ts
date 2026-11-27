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
  await page.getByRole("button", { name: "Paste a GitHub Actions link instead" }).click();
  await page
    .getByLabel("GitHub Actions link")
    .fill("https://github.com/example/app/actions/runs/10/job/20");
  await page.getByRole("button", { name: "Use this run" }).click();
  await expect(page.getByLabel("Commit where it failed")).toHaveValue(snapshot.commit);
  await expect(page.getByText("Taken from the GitHub Actions run.")).toBeVisible();
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
  await expect(page).toHaveURL(/investigations\/inv_browser\?project=prj_browser/);
  await page.getByRole("button", { name: /Full test output/ }).click();
  await expect(page.locator("#evidence pre").getByText("Expected 42, received 41")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Verify a fix" })).toBeVisible();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect an agent" })).toBeVisible();
  await expect(page.getByText("http://localhost:5173/mcp", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("issue #30: keyboard-only composer, evidence and repair flow at narrow and desktop widths", async ({
  page,
}) => {
  const candidateCommit = "b".repeat(40);
  let createWrites = 0;
  let verificationWrites = 0;

  await page.emulateMedia({ reducedMotion: "reduce" });
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
      expect(r.request().postDataJSON()).toMatchObject({
        testPath: execution.command.testPath,
        commit: snapshot.commit,
        mode: "execute",
      });
      createWrites += 1;
      return r.fulfill(json(inv));
    }
    return r.fulfill(json({ items: [] }));
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
  await page.route("**/api/projects/prj_browser/investigations/inv_browser/verify", async (r) => {
    expect(r.request().method()).toBe("POST");
    expect(r.request().postDataJSON()).toEqual({ commit: candidateCommit });
    verificationWrites += 1;
    return r.fulfill(
      json({
        id: "ver_browser",
        baselineId: inv.id,
        candidateId: "inv_candidate",
        candidateCommit,
        verdict: "PENDING",
        label: "Queued",
        baselineRun: null,
        candidateRun: null,
        changedTests: [],
        limitations: [],
        summary: "Checking candidate.",
        metrics: {},
      }),
    );
  });
  await page.route("**/api/projects/prj_browser/repository/index?kind=tests", (r) =>
    r.fulfill(json(null)),
  );
  await page.route("**/api/projects/prj_browser/catalog", (r) =>
    r.fulfill(json({ executionAvailable: true, executionProvider: "github" })),
  );
  await page.route("**/api/projects/prj_browser/repository/setup", (r) =>
    r.fulfill(json({ state: "READY" })),
  );

  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Reproduce a failing test" })).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    const testFile = page.getByLabel("Test file");
    const tabTo = async (locator: typeof testFile) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (await locator.evaluate((element) => element === document.activeElement)) return;
        await page.keyboard.press("Tab");
      }
      throw new Error("Keyboard tab order did not reach the expected investigation control.");
    };
    const expectVisibleFocus = async (locator: typeof testFile) => {
      const styles = await locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth),
          boxShadow: style.boxShadow,
        };
      });
      const hasOutline = styles.outlineStyle !== "none" && styles.outlineWidth >= 2;
      expect(hasOutline || styles.boxShadow !== "none").toBe(true);
    };

    await tabTo(testFile);
    await expectVisibleFocus(testFile);
    await page.keyboard.type(execution.command.testPath);
    const failedCommit = page.getByLabel("Commit where it failed");
    await page.keyboard.press("Tab");
    await expect(failedCommit).toBeFocused();
    await expectVisibleFocus(failedCommit);
    await page.keyboard.type(snapshot.commit);
    const changeInputMode = page.getByRole("button", {
      name: "Paste a GitHub Actions link instead",
    });
    await page.keyboard.press("Tab");
    await expect(changeInputMode).toBeFocused();
    const runTest = page.getByRole("button", { name: "Run test", exact: true });
    await page.keyboard.press("Tab");
    await expect(runTest).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Verify a fix" })).toBeVisible();
    expect(createWrites).toBe(width === 320 ? 1 : 2);
    const evidenceToggle = page.getByRole("button", { name: /Full test output/ });
    await tabTo(evidenceToggle);
    await expectVisibleFocus(evidenceToggle);
    await page.keyboard.press("Enter");
    await expect(evidenceToggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#evidence pre")).toContainText("Expected 42, received 41");
    await expect(evidenceToggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(evidenceToggle).toHaveAttribute("aria-expanded", "false");
    await expect(evidenceToggle).toBeFocused();

    const verifyButton = page.getByRole("button", { name: "Verify", exact: true });
    await tabTo(verifyButton);
    await expect(verifyButton).toBeFocused();
    await expectVisibleFocus(verifyButton);
    await page.keyboard.press("Shift+Tab");
    const fixCommit = page.getByLabel("Fix commit");
    await expect(fixCommit).toBeFocused();
    await expectVisibleFocus(fixCommit);
    await page.keyboard.type("not-a-commit");
    await page.keyboard.press("Tab");
    await expect(verifyButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(fixCommit).toBeFocused();
    const invalidState = await fixCommit.evaluate((element) => {
      const input = element as HTMLInputElement;
      return {
        patternMismatch: input.validity.patternMismatch,
        validationMessage: input.validationMessage,
      };
    });
    expect(invalidState.patternMismatch).toBe(true);
    expect(invalidState.validationMessage.length).toBeGreaterThan(0);
    expect(verificationWrites).toBe(width === 320 ? 0 : 1);

    await page.keyboard.press("Control+A");
    await page.keyboard.type(candidateCommit);
    await expect
      .poll(() => fixCommit.evaluate((element) => (element as HTMLInputElement).checkValidity()))
      .toBe(true);
    await page.keyboard.press("Tab");
    await expect(verifyButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Your fix" })).toBeVisible();
    await expect(page.getByText("Checking candidate.", { exact: true })).toBeVisible();
    expect(verificationWrites).toBe(width === 320 ? 1 : 2);
    await page.keyboard.press("Tab");
    await expect(evidenceToggle).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(verifyButton).toBeFocused();

    const reducedMotion = await page.locator(".page").evaluate((element) => {
      const toMs = (value: string) => {
        const amount = Number.parseFloat(value);
        return value.trim().endsWith("ms") ? amount : amount * 1000;
      };
      return [element, ...element.querySelectorAll("*")].reduce(
        (result, node) => {
          const style = getComputedStyle(node);
          result.animationDurations.push(...style.animationDuration.split(",").map(toMs));
          result.transitionDurations.push(...style.transitionDuration.split(",").map(toMs));
          result.animationIterations.push(
            ...style.animationIterationCount
              .split(",")
              .map((value) => Number.parseFloat(value.trim())),
          );
          return result;
        },
        {
          animationDurations: [] as number[],
          transitionDurations: [] as number[],
          animationIterations: [] as number[],
        },
      );
    });
    expect(Math.max(...reducedMotion.animationDurations)).toBeLessThanOrEqual(0.1);
    expect(Math.max(...reducedMotion.transitionDurations)).toBeLessThanOrEqual(0.1);
    expect(reducedMotion.animationIterations.every((count) => count <= 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test("a CI link prefills the exact Pytest case in its connected repository", async ({ page }) => {
  const testPath = "tests/test_checkout.py";
  const testCase = "TestCheckout::test_total[wallet]";
  const commit = "c".repeat(40);
  let submissions = 0;
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
    r.fulfill(
      json({
        items: [
          { id: "prj_other", name: "Other", repository: "example/other" },
          { id: "prj_browser", name: "Browser", repository: "example/app" },
        ],
      }),
    ),
  );
  await page.route("**/api/projects/*/catalog", (r) =>
    r.fulfill(
      json({
        executionAvailable: true,
        executionProvider: "github",
      }),
    ),
  );
  await page.route("**/api/projects/*/repository/setup", (r) =>
    r.fulfill(json({ state: "READY" })),
  );
  await page.route("**/api/projects/*/repository/index?kind=tests", (r) => r.fulfill(json(null)));
  await page.route("**/api/projects/*/investigations", async (r) => {
    if (r.request().method() === "POST") {
      submissions++;
      expect(new URL(r.request().url()).pathname).toContain("/prj_browser/");
      expect(r.request().postDataJSON()).toMatchObject({
        testPath,
        testCase,
        commit,
        expectedRepository: "example/app",
        mode: "execute",
      });
      await r.fulfill(json(inv));
    } else await r.fulfill(json({ items: [] }));
  });
  await page.route("**/api/projects/prj_browser/investigations/inv_browser", (r) =>
    r.fulfill(json(inv)),
  );
  const query = new URLSearchParams({
    project: "prj_other",
    ciRepository: "example/app",
    ciTest: testPath,
    ciCase: testCase,
    ciCommit: commit,
  });
  await page.goto("/investigations?" + query.toString());
  await expect(page.getByLabel("Test file")).toHaveValue("");
  await page.getByRole("button", { name: "Open repository" }).click();
  await expect(page.getByLabel("Test file")).toHaveValue(testPath);
  await expect(page.getByLabel("Test name (optional)")).toHaveValue(testCase);
  await expect(page.getByLabel("Commit where it failed")).toHaveValue(commit);
  expect(submissions).toBe(0);
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
  expect(submissions).toBe(1);
});

test("local account opens a real persisted investigation and returns to the same evidence", async ({
  page,
}) => {
  await page.goto("/__acceptance/account");
  await page.getByRole("button", { name: "Open local test account" }).click();
  await expect(page.getByRole("heading", { name: "Reproduce a failing test" })).toBeVisible();
  const projects = await (await page.request.get("/api/projects")).json();
  const project = projects.data.items[0];
  expect(project.id).toBeTruthy();
  const response = await page.request.post(`/api/projects/${project.id}/investigations`, {
    data: { question: "Inspect retained repository evidence", mode: "analyze" },
  });
  expect(response.status()).toBe(201);
  const { data } = await response.json();
  await page.goto(data.browserPath);
  await expect(page.getByRole("heading", { name: "What Traceyard found" })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Inspect retained repository evidence" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Investigations", exact: true }).first().click();
  await expect(
    page.getByText("Inspect retained repository evidence", { exact: true }).first(),
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
  // The full executed SHA is visible, not only a short prefix.
  await expect(page.getByLabel("Executed commit")).toHaveText(snapshot.commit);
  await expect(page.getByRole("link", { name: "Open after evidence" })).toHaveAttribute(
    "href",
    "/investigations/inv_candidate?project=prj_browser&evidence=evd_candidate#evidence",
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

test("incomplete execution setup blocks test launch until the workflow is set up", async ({
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
  await expect(page.getByRole("button", { name: "Run test", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Update the GitHub workflow" }).click();
  const dialog = page.getByRole("dialog", { name: "Run tests in GitHub Actions" });
  await expect(dialog.getByText("name: Reviewed workflow")).toBeVisible();
  expect(setupWrites).toBe(0);
  await dialog.getByRole("button", { name: "Open pull request" }).click();
  await expect(dialog.getByRole("link", { name: "Open pull request" })).toHaveAttribute(
    "href",
    "https://github.com/example/app/pull/1",
  );
  expect(setupWrites).toBe(1);
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Run test", exact: true })).toBeDisabled();
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
  await expect(page.getByRole("heading", { name: "Start with a repository" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Connect an agent" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy URL" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("What happens next");
  await expect(page.getByRole("link", { name: "Review access" })).toHaveAttribute(
    "href",
    "#agent-access",
  );
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
    "repositories",
    "agents",
    "settings/account",
    "settings/appearance",
  ];
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    for (const route of routes) {
      await page.goto("/" + route);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
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
