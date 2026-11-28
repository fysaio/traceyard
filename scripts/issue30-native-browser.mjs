import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Builder, By, Key } from "selenium-webdriver";

const browserName = process.env.ISSUE30_BROWSER;
const baseUrl = process.env.ISSUE30_BASE_URL ?? "http://127.0.0.1:5173";
const outputDir = resolve(process.env.ISSUE30_OUTPUT_DIR ?? "test-results/issue-30-native-browser");
const expectedTestPath = "tests/checkout.test.ts";
const failedCommit = "a".repeat(40);
const candidateCommit = "b".repeat(40);
const targetViewports = [320, 1440];

assert.equal(browserName, "safari", "ISSUE30_BROWSER must be safari");
await mkdir(outputDir, { recursive: true });

const driver = await new Builder().forBrowser("safari").build();
const results = [];

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitUntil(description, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ""}`);
}

async function labelledControl(labelText) {
  const element = await driver.executeScript(
    `const field = [...document.querySelectorAll(".field")].find((item) =>
       item.querySelector(".field-label")?.textContent.trim() === arguments[0]);
     const accessible = [...document.querySelectorAll("[aria-label]")].find((item) => item.getAttribute("aria-label") === arguments[0]);
     return field?.querySelector("input, textarea, select") || accessible || null;`,
    labelText,
  );
  assert.ok(element, `Could not find the form control labelled “${labelText}”.`);
  return element;
}

async function buttonContaining(text) {
  const button = await driver.executeScript(
    `return [...document.querySelectorAll("button")].find((item) =>
      item.textContent.trim().includes(arguments[0]) || (item.getAttribute("aria-label") || "").includes(arguments[0]));`,
    text,
  );
  assert.ok(button, `Could not find a button containing “${text}”.`);
  return button;
}

async function isFocused(element) {
  return driver.executeScript("return arguments[0] === document.activeElement", element);
}

async function tabTo(element, description) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await isFocused(element)) return;
    await driver.actions().sendKeys(Key.TAB).perform();
  }
  const active = await driver.executeScript(
    `const e = document.activeElement; return {tag:e?.tagName, id:e?.id, label:e?.labels?.[0]?.textContent?.trim(), text:e?.textContent?.trim()};`,
  );
  throw new Error(
    `Keyboard Tab did not reach ${description}; active element: ${JSON.stringify(active)}`,
  );
}

async function assertVisibleFocus() {
  const style = await driver.executeScript(
    `const s = getComputedStyle(document.activeElement); return {outlineStyle:s.outlineStyle, outlineWidth:s.outlineWidth, boxShadow:s.boxShadow};`,
  );
  const width = Number.parseFloat(style.outlineWidth);
  const visibleOutline =
    style.outlineStyle !== "none" && (width >= 2 || style.outlineWidth === "auto");
  assert.ok(
    visibleOutline || style.boxShadow !== "none",
    `No visible focus indicator: ${JSON.stringify(style)}`,
  );
}

async function enterOnFocusedElement() {
  await driver.switchTo().activeElement().sendKeys(Key.ENTER);
}

async function waitForText(text) {
  await waitUntil(`page text ${JSON.stringify(text)}`, async () => {
    const body = await driver.findElement(By.css("body")).getText();
    return body.includes(text);
  });
}

async function setCssViewport(targetWidth, targetHeight = 900) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = await driver.executeScript(
      "return {width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? 1}",
    );
    if (current.width === targetWidth && current.height === targetHeight) return current;
    const rect = await driver.manage().window().getRect();
    await driver
      .manage()
      .window()
      .setRect({
        x: rect.x,
        y: rect.y,
        width: Math.max(320, rect.width + targetWidth - current.width),
        height: Math.max(480, rect.height + targetHeight - current.height),
      });
    await sleep(150);
  }
  const actual = await driver.executeScript(
    "return {width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? 1}",
  );
  if (
    targetWidth === 320 &&
    actual.width >= 320 &&
    actual.width <= 375 &&
    actual.height === targetHeight
  ) {
    console.warn(
      `Safari constrained the requested 320px narrow viewport to ${actual.width}px; recording and testing the actual width.`,
    );
    return actual;
  }
  assert.deepEqual(
    { width: actual.width, height: actual.height },
    { width: targetWidth, height: targetHeight },
    `Could not set the requested CSS viewport; actual metrics: ${JSON.stringify(actual)}`,
  );
  return actual;
}

try {
  await driver.manage().setTimeouts({ implicit: 0, pageLoad: 30000, script: 10000 });
  await driver.manage().window().setRect({ x: 0, y: 0, width: 1440, height: 1000 });
  await driver.get(`${baseUrl}/__acceptance/issue30`);
  await waitUntil("the isolated synthetic fixture entry page", () =>
    driver.findElement(By.css("button")),
  );
  // This click only bootstraps the local, synthetic session. Every product-flow action below is keyboard-only.
  await driver.findElement(By.css("button")).click();
  await waitForText("Reproduce a failing test");

  const capabilities = await driver.getCapabilities();
  const browserVersion = capabilities.get("browserVersion") ?? "unknown";
  const userAgent = await driver.executeScript("return navigator.userAgent");
  const osLabel = process.env.ISSUE30_OS_LABEL ?? process.platform;
  for (const width of targetViewports) {
    if (width !== targetViewports[0]) {
      await driver.get(`${baseUrl}/`);
      await waitForText("Reproduce a failing test");
    }
    const viewport = await setCssViewport(width);
    assert.equal(
      await driver.executeScript("return matchMedia('(prefers-reduced-motion: reduce)').matches"),
      true,
      "The browser did not report the reduced-motion preference.",
    );
    assert.equal(
      await driver.executeScript("return document.documentElement.scrollWidth <= innerWidth"),
      true,
      `The page overflows horizontally at ${width}px.`,
    );

    const testFile = await labelledControl("Test file");
    await tabTo(testFile, "the test file field");
    await assertVisibleFocus();
    await driver.switchTo().activeElement().sendKeys(expectedTestPath);

    const failedCommitInput = await labelledControl("Commit where it failed");
    await driver.actions().sendKeys(Key.TAB).perform();
    assert.equal(
      await isFocused(failedCommitInput),
      true,
      "Tab should focus the failed commit field.",
    );
    await assertVisibleFocus();
    await driver.switchTo().activeElement().sendKeys(failedCommit);

    const changeModeButton = await buttonContaining("Paste a GitHub Actions link instead");
    await driver.actions().sendKeys(Key.TAB).perform();
    assert.equal(
      await isFocused(changeModeButton),
      true,
      "Tab should reach the input-mode button.",
    );
    const runButton = await buttonContaining("Run test");
    await driver.actions().sendKeys(Key.TAB).perform();
    assert.equal(await isFocused(runButton), true, "Tab should reach Run test.");
    await enterOnFocusedElement();
    await waitForText("What happened");
    await waitForText("Verify a fix");

    const evidenceToggle = await buttonContaining("Full test output");
    await tabTo(evidenceToggle, "the retained evidence control");
    await assertVisibleFocus();
    await enterOnFocusedElement();
    await waitUntil(
      "evidence expansion",
      async () => (await evidenceToggle.getAttribute("aria-expanded")) === "true",
    );
    await waitForText("Expected 42, received 41");
    assert.equal(
      await isFocused(evidenceToggle),
      true,
      "Opening evidence should retain focus on its control.",
    );
    await enterOnFocusedElement();
    await waitUntil(
      "evidence collapse",
      async () => (await evidenceToggle.getAttribute("aria-expanded")) === "false",
    );
    assert.equal(
      await isFocused(evidenceToggle),
      true,
      "Closing evidence should retain focus on its control.",
    );

    const verifyButton = await buttonContaining("Verify");
    await tabTo(verifyButton, "the repair Verify button");
    await assertVisibleFocus();
    await driver.actions().sendKeys(Key.SHIFT, Key.TAB).perform();
    const fixCommit = await labelledControl("Fix commit");
    assert.equal(
      await isFocused(fixCommit),
      true,
      "Shift+Tab should return to the fix commit field.",
    );
    await assertVisibleFocus();
    await driver.switchTo().activeElement().sendKeys("not-a-commit");
    await driver.actions().sendKeys(Key.TAB).perform();
    assert.equal(
      await isFocused(verifyButton),
      true,
      "Tab should return to Verify after the fix field.",
    );
    await enterOnFocusedElement();
    assert.equal(
      await isFocused(fixCommit),
      true,
      "Invalid repair input should return focus to its field.",
    );
    const invalid = await driver.executeScript(
      "return {patternMismatch: arguments[0].validity.patternMismatch, validationMessage: arguments[0].validationMessage}",
      fixCommit,
    );
    assert.equal(
      invalid.patternMismatch,
      true,
      "The malformed commit should fail native form validation.",
    );
    assert.ok(
      invalid.validationMessage.length > 0,
      "The malformed commit should expose a validation message.",
    );

    await driver.switchTo().activeElement().sendKeys(Key.META, "a");
    await driver.switchTo().activeElement().sendKeys(candidateCommit);
    const valid = await driver.executeScript("return arguments[0].checkValidity()", fixCommit);
    assert.equal(valid, true, "The valid candidate SHA should pass native form validation.");
    await driver.actions().sendKeys(Key.TAB).perform();
    assert.equal(
      await isFocused(verifyButton),
      true,
      "Tab should reach Verify after the valid SHA.",
    );
    await enterOnFocusedElement();
    await waitForText("Your fix");
    await waitForText("Checking candidate.");
    await driver.actions().sendKeys(Key.TAB).perform();
    assert.equal(
      await isFocused(evidenceToggle),
      true,
      "Tab should continue from repair verification to evidence.",
    );
    await driver.actions().sendKeys(Key.SHIFT, Key.TAB).perform();
    assert.equal(
      await isFocused(verifyButton),
      true,
      "Shift+Tab should return from evidence to Verify.",
    );

    const reducedMotionState = await driver.executeScript(
      `const root = document.querySelector(".page");
       const durationMs = (value) => { const n = Number.parseFloat(value); return value.trim().endsWith("ms") ? n : n * 1000; };
       const nodes = [root, ...root.querySelectorAll("*")];
       return nodes.reduce((state, node) => {
         const style = getComputedStyle(node);
         state.animationDurations.push(...style.animationDuration.split(",").map(durationMs));
         state.transitionDurations.push(...style.transitionDuration.split(",").map(durationMs));
         return state;
       }, {animationDurations: [], transitionDurations: []});`,
    );
    assert.ok(
      Math.max(...reducedMotionState.animationDurations) <= 0.1,
      "Animations should respect reduced motion.",
    );
    assert.ok(
      Math.max(...reducedMotionState.transitionDurations) <= 0.1,
      "Transitions should respect reduced motion.",
    );
    assert.equal(
      await driver.executeScript("return document.documentElement.scrollWidth <= innerWidth"),
      true,
      `The page should not overflow horizontally at ${viewport.width}px.`,
    );

    const screenshotPath = resolve(outputDir, `issue-30-${browserName}-${viewport.width}px.png`);
    const screenshot = await driver.takeScreenshot();
    await writeFile(screenshotPath, Buffer.from(screenshot, "base64"));
    results.push({
      requestedViewport: { width, height: 900 },
      viewport,
      steps: [
        "Keyboard-tab through the test path, failed commit, input-mode control, and Run test button.",
        "Open and close retained evidence with Enter and confirm focus remains on its control.",
        "Tab to Verify, Shift+Tab to the repair field, and verify invalid-SHA error/focus behavior.",
        "Replace the repair SHA with the platform Select All shortcut, submit by keyboard, and verify focus order without a trap.",
        "Confirm reduced-motion preference, bounded animation/transition timing, and no horizontal overflow.",
      ],
      result: "passed",
      screenshot: screenshotPath,
      reducedMotion: true,
      invalidCommit: invalid,
    });
  }

  const report = {
    issue: 30,
    commit: process.env.GITHUB_SHA ?? "local-uncommitted",
    browser: browserName,
    browserVersion,
    userAgent,
    operatingSystem: osLabel,
    platform: process.platform,
    viewportZoom: "100% browser default; CSS viewport and devicePixelRatio recorded per case",
    assistiveTechnology:
      "Not enabled in automated browser job; VoiceOver manual observation remains separate.",
    syntheticDataOnly: true,
    results,
  };
  const reportPath = resolve(outputDir, `issue-30-${browserName}-results.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await driver.quit();
}
