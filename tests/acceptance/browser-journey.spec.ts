import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const exec = promisify(execFile);
const cli = resolve("agent/cli.mjs");
const scenario = {
  version: 1,
  site: "site",
  start: "/",
  responses: { "/api/cart": null },
  steps: [
    { action: "click", testId: "show-total" },
    { action: "expectText", testId: "total", text: "$42.00" },
  ],
};

function storefront(regression: number, extraRequest = "") {
  return `<!doctype html>
  <link rel="icon" href="data:,">
  <button data-testid="show-total">Show total</button>
  <output data-testid="total"></output>
  <script>
    document.querySelector("button").onclick = async () => {
      const { subtotal, delivery } = await fetch("/api/cart").then((r) => r.json());
      ${extraRequest}
      document.querySelector("output").textContent =
        "$" + (subtotal + delivery - ${regression}).toFixed(2);
    };
  </script>`;
}

test("browser journey reuses a captured response and reports a fix or missing evidence", async ({
  browser,
}, testInfo) => {
  const repo = await mkdtemp(join(tmpdir(), "traceyard-browser-"));
  const recording = join(repo, "recording.har");
  let externalRequests = 0;
  const source = createServer((request, response) => {
    if (request.url === "/api/cart") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ subtotal: 39, delivery: 3 }));
    } else if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(storefront(1));
    } else {
      if (request.url === "/should-not-run") externalRequests++;
      response.writeHead(404);
      response.end();
    }
  });
  try {
    await new Promise<void>((ready, reject) => {
      source.once("error", reject);
      source.listen(0, "127.0.0.1", ready);
    });
    const address = source.address();
    if (!address || typeof address === "string") throw Error("Fixture server has no port.");
    const origin = `http://127.0.0.1:${address.port}`;
    const record = await browser.newContext({ recordHar: { path: recording, content: "embed" } });
    try {
      const page = await record.newPage();
      await page.goto(origin);
      await page.getByTestId("show-total").click();
      await expect(page.getByTestId("total")).toHaveText("$41.00");
    } finally {
      await record.close();
    }

    const git = async (...args: string[]) => (await exec("git", args, { cwd: repo })).stdout.trim();
    const run = (...args: string[]) => exec(process.execPath, [cli, ...args], { cwd: repo });
    await git("init", "-q");
    await mkdir(join(repo, "site"));
    const commit = async (html: string, message: string) => {
      await writeFile(join(repo, "site/index.html"), html);
      await git("add", "site");
      await git(
        "-c",
        "user.name=Traceyard",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--no-gpg-sign",
        "-qm",
        message,
      );
      return git("rev-parse", "HEAD");
    };
    const baseline = await commit(storefront(1), "Checkout undercounts delivery");
    const fix = await commit(storefront(0), "Add the full delivery cost");
    const unrecordedRequest = JSON.stringify(origin + "/should-not-run");
    const incomplete = await commit(
      storefront(0, `await fetch(${unrecordedRequest}).catch(() => {});`),
      "Checkout reads an unrecorded third-party service",
    );

    const draft = join(repo, "draft.json");
    const journey = join(repo, "journey.json");
    await writeFile(draft, JSON.stringify(scenario));
    const { stdout: capture } = await run("browser-fixtures", draft, recording, origin);
    expect(JSON.parse(capture)).toEqual({
      ...scenario,
      responses: { "/api/cart": { subtotal: 39, delivery: 3 } },
    });
    await writeFile(journey, capture);

    const summary = join(repo, "summary.md");
    const { stdout } = await exec(
      process.execPath,
      [cli, "compare-browser", journey, baseline, fix],
      {
        cwd: repo,
        env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary },
      },
    );
    const fixed = JSON.parse(stdout);
    expect(fixed).toMatchObject({
      verdict: "FIXED",
      baseline: { commit: baseline, status: "FAILED", step: 2 },
      candidate: { commit: fix, status: "PASSED", stepsCompleted: 2 },
    });
    expect(await readFile(summary, "utf8")).toContain("Result: **FIXED**");

    const blocked = await run("compare-browser", journey, baseline, incomplete).catch((error) => {
      expect(error.code).toBe(2);
      return error;
    });
    const inconclusive = JSON.parse(blocked.stdout);
    expect(inconclusive).toMatchObject({
      verdict: "INCONCLUSIVE",
      candidate: {
        commit: incomplete,
        status: "INCONCLUSIVE",
        unrecordedRequests: [`GET ${origin}/should-not-run`],
      },
    });
    expect(externalRequests).toBe(0);
    await mkdir(testInfo.outputDir, { recursive: true });
    const evidence = testInfo.outputPath("browser-journey-evidence.json");
    await writeFile(evidence, JSON.stringify({ fixed, inconclusive }, null, 2));
    await testInfo.attach("browser-journey-evidence", {
      path: evidence,
      contentType: "application/json",
    });
  } finally {
    source.closeAllConnections();
    if (source.listening) await promisify(source.close.bind(source))();
    await rm(repo, { recursive: true, force: true });
  }
});
