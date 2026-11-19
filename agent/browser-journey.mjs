import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { chromium, expect } from "@playwright/test";
import { z } from "zod";

const origin = "http://traceyard.test";
const journeyLimit = 256 * 1024;
const shaPattern = /^[a-f0-9]{40}$/;
const pathSegments = /^[a-zA-Z0-9_@.-]+(?:\/[a-zA-Z0-9_@.-]+)*$/;
const isFilePath = (value) =>
  pathSegments.test(value) && !value.split("/").some((part) => [".", "..", ".git"].includes(part));
const pagePath = z
  .string()
  .max(240)
  .refine((path) => path === "/" || (path.startsWith("/") && isFilePath(path.slice(1))));
const testId = z.string().min(1).max(120);
const journeySchema = z
  .strictObject({
    version: z.literal(1),
    site: z.string().max(240).refine(isFilePath, "Select a directory of committed static files."),
    start: pagePath,
    responses: z.record(pagePath, z.json()),
    steps: z
      .array(
        z.discriminatedUnion("action", [
          z.strictObject({ action: z.literal("click"), testId }),
          z.strictObject({ action: z.literal("fill"), testId, value: z.string().max(4000) }),
          z.strictObject({ action: z.literal("expectText"), testId, text: z.string().max(4000) }),
        ]),
      )
      .min(1)
      .max(20),
  })
  .refine(
    ({ steps }) => steps.some((step) => step.action === "expectText"),
    "A journey needs a text assertion.",
  );

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const harSchema = z.object({
  log: z.object({
    entries: z.array(
      z.object({
        request: z.object({ method: z.string(), url: z.url() }),
        response: z.object({
          status: z.number(),
          content: z.object({
            mimeType: z.string(),
            text: z.string().optional(),
            encoding: z.string().optional(),
          }),
        }),
      }),
    ),
  }),
});

async function readLimited(file, limit) {
  if ((await stat(file)).size > limit) throw Error(`File exceeds ${limit} bytes: ${file}`);
  return readFile(file, "utf8");
}

function parseJourney(rawJourney) {
  if (Buffer.byteLength(rawJourney) > journeyLimit)
    throw Error("The journey file exceeds 256 KiB.");
  return journeySchema.parse(JSON.parse(rawJourney));
}

export async function browserFixturesCommand(args) {
  if (args.length !== 3)
    throw Error(
      "Usage: traceyard browser-fixtures <journey.json> <recording.har> <recorded origin>",
    );
  const [file, archive, recordedOrigin] = args;
  const allowed = new URL(recordedOrigin);
  if (!["http:", "https:"].includes(allowed.protocol) || recordedOrigin !== allowed.origin)
    throw Error("Provide the recorded origin, including scheme and port if used, without a path.");
  const journey = parseJourney(await readLimited(file, journeyLimit));
  const { log } = harSchema.parse(JSON.parse(await readLimited(archive, 16 * 1024 * 1024)));
  const captured = new Map();
  for (const { request, response } of log.entries) {
    const { origin: requestOrigin, pathname, search } = new URL(request.url);
    const { mimeType, text, encoding } = response.content;
    if (
      requestOrigin !== allowed.origin ||
      request.method !== "GET" ||
      search ||
      !Object.hasOwn(journey.responses, pathname)
    )
      continue;
    if (
      response.status !== 200 ||
      mimeType.split(";")[0].trim().toLowerCase() !== "application/json" ||
      text === undefined ||
      (encoding !== undefined && encoding !== "base64")
    )
      throw Error(`Expected a recorded HTTP 200 JSON response for ${pathname}.`);
    const json = z
      .json()
      .parse(JSON.parse(encoding ? Buffer.from(text, "base64").toString() : text));
    const serialized = JSON.stringify(json);
    if (captured.has(pathname) && captured.get(pathname) !== serialized)
      throw Error(`Recording has different responses for ${pathname}.`);
    captured.set(pathname, serialized);
  }
  const responses = Object.fromEntries(
    Object.keys(journey.responses).map((path) => {
      if (!captured.has(path)) throw Error(`Recording is missing ${path}.`);
      return [path, JSON.parse(captured.get(path))];
    }),
  );
  const output = JSON.stringify({ ...journey, responses }, null, 2);
  parseJourney(output);
  console.log(output);
}

function git(directory, args, encoding) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10000,
  });
}

function loadSite(directory, commit, site) {
  if (
    !shaPattern.test(commit) ||
    git(directory, ["rev-parse", "--verify", `${commit}^{commit}`], "utf8").trim() !== commit
  )
    throw Error("Provide a full Git commit SHA for each revision.");
  const files = new Map();
  const prefix = site + "/";
  const listing = git(directory, ["ls-tree", "-rz", "--full-tree", commit, "--", site], "utf8");
  for (const entry of listing.split("\0")) {
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t(.+)$/s.exec(entry);
    if (!match || !match[2].startsWith(prefix)) continue;
    const path = match[2].slice(prefix.length);
    if (isFilePath(path) && Object.hasOwn(contentTypes, extname(path)))
      files.set("/" + path, match[1]);
  }
  if (!files.size) throw Error(`No committed static site files at ${site} in ${commit}.`);
  return files;
}

async function runJourney(browser, directory, commit, files, journey) {
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  const unexpected = new Set();
  let step = 0;
  let action = "visit";
  let outcome;
  try {
    await context.routeWebSocket(
      () => true,
      async (socket) => {
        unexpected.add("WebSocket");
        await socket.close();
      },
    );
    await context.route(
      () => true,
      async (route) => {
        const request = route.request();
        const { origin: requestOrigin, pathname, search } = new URL(request.url());
        const method = request.method();
        if (requestOrigin === origin && method === "GET" && !search) {
          if (["fetch", "xhr"].includes(request.resourceType())) {
            if (Object.hasOwn(journey.responses, pathname)) {
              await route.fulfill({ json: journey.responses[pathname] });
              return;
            }
          } else {
            const path = pathname === "/" ? "/index.html" : pathname;
            const blob = files.get(path);
            if (blob) {
              try {
                await route.fulfill({
                  contentType: contentTypes[extname(path)],
                  body: git(directory, ["cat-file", "blob", blob]),
                });
                return;
              } catch {
                unexpected.add("Unavailable static asset");
                await route.abort();
                return;
              }
            }
          }
        }
        if (unexpected.size < 10)
          unexpected.add(`${method} ${requestOrigin}${pathname}`.slice(0, 260));
        await route.abort();
      },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    await page.goto(origin + journey.start, { timeout: 5000 });
    for (const next of journey.steps) {
      if (unexpected.size) break;
      step++;
      action = next.action;
      const locator = page.getByTestId(next.testId);
      if (action === "click") await locator.click();
      else if (action === "fill") await locator.fill(next.value);
      else await expect(locator).toHaveText(next.text, { timeout: 2000 });
    }
    outcome = { commit, status: "PASSED", stepsCompleted: step };
  } catch (error) {
    outcome = {
      commit,
      status: action === "expectText" && error.matcherResult ? "FAILED" : "INCONCLUSIVE",
      step,
      action,
      diagnostic: stripVTControlCharacters(String(error.message)).slice(0, 1200),
    };
  } finally {
    await context.close();
  }
  return unexpected.size
    ? { commit, status: "INCONCLUSIVE", step, action, unrecordedRequests: [...unexpected] }
    : outcome;
}

export async function compareBrowserJourney(
  browser,
  directory,
  rawJourney,
  baselineCommit,
  candidateCommit,
) {
  const journey = parseJourney(rawJourney);
  if (baselineCommit === candidateCommit) throw Error("Select two different commits to compare.");
  const baselineFiles = loadSite(directory, baselineCommit, journey.site);
  const candidateFiles = loadSite(directory, candidateCommit, journey.site);
  const baseline = await runJourney(browser, directory, baselineCommit, baselineFiles, journey);
  const candidate = await runJourney(browser, directory, candidateCommit, candidateFiles, journey);
  const outcomes = {
    "FAILED:PASSED": "FIXED",
    "PASSED:FAILED": "REGRESSION",
    "FAILED:FAILED": "STILL_FAILING",
    "PASSED:PASSED": "PASSED",
  };
  return {
    version: 1,
    journeySha256: createHash("sha256").update(rawJourney).digest("hex"),
    verdict: outcomes[`${baseline.status}:${candidate.status}`] ?? "INCONCLUSIVE",
    baseline,
    candidate,
  };
}

export async function browserCompareCommand(args) {
  const [file, baseline, candidate] = args;
  if (args.length !== 3 || !shaPattern.test(baseline) || !shaPattern.test(candidate))
    throw Error("Usage: traceyard compare-browser <journey.json> <baseline SHA> <candidate SHA>");
  const journey = await readLimited(file, journeyLimit);
  const browser = await chromium.launch();
  try {
    const result = await compareBrowserJourney(
      browser,
      process.cwd(),
      journey,
      baseline,
      candidate,
    );
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_STEP_SUMMARY) {
      const row = (label, run) =>
        `| ${label} | \`${run.commit}\` | ${run.status} | ${run.step ?? "—"} |`;
      const summary = [
        "",
        "### Traceyard browser journey",
        "",
        `Result: **${result.verdict}**`,
        "",
        "| Revision | Commit | Outcome | First issue at step |",
        "| --- | --- | --- | --- |",
        row("Baseline", result.baseline),
        row("Candidate", result.candidate),
        "",
      ];
      try {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, summary.join("\n"));
      } catch {
        console.warn("GitHub summary could not be written. The comparison is in the job output.");
      }
    }
    process.exitCode =
      result.verdict === "INCONCLUSIVE" ? 2 : result.candidate.status === "FAILED" ? 1 : 0;
  } finally {
    await browser.close();
  }
}
