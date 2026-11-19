import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { compareBrowserJourney } from "../agent/browser-journey.mjs";
import { startBrowserRecorder } from "../agent/browser-record.mjs";
import { readBuildSite } from "../agent/browser-site.mjs";

const run = promisify(execFile);
const [base, head, baseDir, headDir, evidenceDir] = process.argv.slice(2);
if (!evidenceDir) throw Error("Supply two commits, their build paths and an evidence directory.");

const repeatRequestPage = `<!doctype html>
  <link rel="icon" href="data:,">
  <button data-testid="run">Run parallel requests</button><output data-testid="result"></output>
  <script>
    document.querySelector("button").onclick = async () => {
      const read = async () => {
        const response = await fetch("/api/recording-order?item=single", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ count: 1, item: "single" }),
        });
        return response.status + ":" + (await response.json()).order;
      };
      document.querySelector("output").textContent = (await Promise.all([read(), new Promise((ready) => setTimeout(ready, 60)).then(read)])).join(", ");
    };
  </script>`;
let requests = 0;

async function verifyRequestOrder(browser, origin, temp) {
  const record = await startBrowserRecorder(browser, new URL(origin + "/recording-order"), {
    paths: new Set(["/api/recording-order"]),
    site: "dist",
    inputs: false,
  });
  try {
    await record.page.getByTestId("run").click();
    await expect(record.page.getByTestId("result")).toHaveText("201:1, 202:2");
    await record.page.getByRole("button", { name: "Assert text" }).click();
    await record.page.getByTestId("result").click();
    await record.page.getByRole("button", { name: "Save journey" }).click();
    const raw = await record.completed;
    const { exchanges } = JSON.parse(raw);
    assert.deepEqual(
      exchanges.map(({ status, response }) => [status, response.order]),
      [
        [201, 1],
        [202, 2],
      ],
    );
    assert.deepEqual(exchanges[0].body, { count: 1, item: "single" });
    assert.equal(exchanges[0].url, "/api/recording-order?item=single");
    const files = join(temp, "parallel-build");
    await mkdir(files);
    await writeFile(join(files, "index.html"), repeatRequestPage);
    const result = await compareBrowserJourney(browser, temp, raw, base, head, {
      baselineBuild: files,
      candidateBuild: files,
    });
    assert.equal(result.verdict, "PASSED", JSON.stringify(result));
    const noBody = join(temp, "without-body");
    await mkdir(noBody);
    await writeFile(
      join(noBody, "index.html"),
      repeatRequestPage.replace('body: JSON.stringify({ count: 1, item: "single" }),', ""),
    );
    const manifest = JSON.parse(raw);
    manifest.exchanges[0].body = null;
    manifest.exchanges.pop();
    const mismatched = await compareBrowserJourney(
      browser,
      temp,
      JSON.stringify(manifest),
      base,
      head,
      {
        baselineBuild: noBody,
        candidateBuild: noBody,
      },
    );
    assert.equal(mismatched.verdict, "INCONCLUSIVE");
    assert.deepEqual(mismatched.candidate.unusedFixtures, ["POST /api/recording-order"]);
    assert.equal(requests, 2);
    console.log(
      "Parallel JSON requests replayed in issue order without reaching the fixture server.",
    );
    console.log("A missing request body could not consume an explicit JSON null fixture.");
  } finally {
    await record.close();
  }
}

const candidateSite = await readBuildSite(headDir);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/recording-order") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(repeatRequestPage);
  } else if (url.pathname === "/api/recording-order") {
    const order = ++requests;
    request.resume();
    const respond = () => {
      response.writeHead(200 + order, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ order }));
    };
    if (order === 1) setTimeout(respond, 300);
    else respond();
  } else if (url.pathname === "/api/auth/session") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ data: { user: null, sessions: [], githubSignInAvailable: true } }),
    );
  } else {
    const asset = await candidateSite.get(
      url.pathname,
      request.headers["sec-fetch-mode"] === "navigate",
    );
    if (asset) {
      response.writeHead(200, { "Content-Type": asset.contentType });
      response.end(asset.body);
    } else {
      response.writeHead(404);
      response.end();
    }
  }
});
const temp = await mkdtemp(join(tmpdir(), "traceyard-browser-verification-"));
try {
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  const browser = await chromium.launch();
  let journey;
  try {
    const origin = "http://127.0.0.1:" + address.port;
    await verifyRequestOrder(browser, origin, temp);
    const record = await startBrowserRecorder(browser, new URL(origin + "/?signIn=retry"), {
      paths: new Set(["/api/auth/session"]),
      site: "dist/client",
      inputs: false,
    });
    const alert = record.page.getByRole("alert");
    await expect(alert).toHaveText(
      "That sign-in link expired or could not be verified. Continue with GitHub to try again.",
    );
    await record.page.getByRole("button", { name: "Assert text" }).click();
    await alert.click();
    await record.page.getByRole("button", { name: "Save journey" }).click();
    journey = await record.completed;
    const { steps, exchanges } = JSON.parse(journey);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].action, "expectText");
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0].url, "/api/auth/session");
  } finally {
    await browser.close();
  }
  const configDir = join(temp, ".traceyard");
  await mkdir(join(configDir, "browser"), { recursive: true });
  const journeyPath = join(configDir, "browser", "expired-login.json");
  await writeFile(journeyPath, journey);
  await run(
    process.execPath,
    [resolve("agent/cli.mjs"), "setup-browser", "dist/client", "--runner-revision", head],
    { cwd: temp },
  );
  const workflow = await readFile(join(temp, ".github/workflows/traceyard-browser.yml"), "utf8");
  assert(workflow.includes("path: dist/client/") && workflow.includes("ref: " + head));

  for (const [label, first, second, firstDir, secondDir, verdict] of [
    ["repair", base, head, baseDir, headDir, "FIXED"],
    ["regression", head, base, headDir, baseDir, "REGRESSION"],
  ]) {
    const evidence = resolve(evidenceDir, label);
    await mkdir(evidence, { recursive: true });
    const args = [
      resolve("runner/browser-check.sh"),
      configDir,
      first,
      second,
      resolve(firstDir),
      resolve(secondDir),
      evidence,
    ];
    await run("bash", args).catch((error) => {
      if (verdict === "REGRESSION" && error.code === 1 && error.stdout) return error;
      throw error;
    });
    const assets = join(evidence, "journeys", "expired-login");
    const result = JSON.parse(await readFile(join(assets, "result.json"), "utf8"));
    assert.equal(result.verdict, verdict);
    assert.match(result.baseline.buildSha256, /^[0-9a-f]{64}$/);
    assert.match(result.candidate.buildSha256, /^[0-9a-f]{64}$/);
    assert(result.visual.changedPixels > 0);
    for (const path of ["baseline.png", "candidate.png", "diff.png", "summary.md"])
      assert((await readFile(join(assets, path))).length > 0);
    console.log(label + ": " + verdict + ", " + result.visual.changedPixels + " changed pixels");
  }
  await writeFile(resolve(evidenceDir, "browser-journey.json"), journey);
} finally {
  server.closeAllConnections();
  if (server.listening) await promisify(server.close.bind(server))();
  await rm(temp, { recursive: true, force: true });
}
