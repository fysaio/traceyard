import { createHash } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { browserEvidence, viewport } from "./browser-evidence.mjs";
import { isFilePath, readBuildSite, readCommitSite, shaPattern } from "./browser-site.mjs";
import { stripVTControlCharacters } from "node:util";
import { chromium, expect } from "@playwright/test";
import { z } from "zod";

const origin = "http://traceyard.test";
const journeyLimit = 256 * 1024;
const pagePath = z
  .string()
  .max(240)
  .refine((path) => path === "/" || (path.startsWith("/") && isFilePath(path.slice(1))));
const sameOriginPath = z
  .string()
  .max(1024)
  .refine((value) => value.startsWith("/") && !value.startsWith("//") && !/[\\\\#]/.test(value));
const testId = z.string().min(1).max(120).optional();
const selector = z.string().min(1).max(400).optional();
const target = { testId, selector };
const exchange = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: sameOriginPath,
  body: z.json().optional(),
  status: z
    .number()
    .int()
    .min(200)
    .max(599)
    .refine((status) => status < 300 || status >= 400),
  response: z.json(),
});
const step = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("click"), ...target }),
  z.strictObject({ action: z.literal("fill"), ...target, value: z.string().max(4000) }),
  z.strictObject({ action: z.literal("expectText"), ...target, text: z.string().min(1).max(4000) }),
  z.strictObject({ action: z.literal("expectUrl"), url: sameOriginPath }),
  z.strictObject({ action: z.literal("visit"), url: sameOriginPath }),
]);
const journeySchema = z
  .strictObject({
    version: z.literal(1),
    site: z.string().max(240).refine(isFilePath, "Select a directory of static browser files."),
    start: sameOriginPath,
    responses: z.record(pagePath, z.json()).default({}),
    exchanges: z.array(exchange).max(80).default([]),
    steps: z.array(step).min(1).max(40),
  })
  .refine(
    ({ steps }) =>
      steps.every((step) => "url" in step || Boolean(step.testId) !== Boolean(step.selector)),
    "Provide one locator per action.",
  )
  .refine(
    ({ steps }) => steps.some((step) => ["expectText", "expectUrl"].includes(step.action)),
    "A journey needs an assertion.",
  );

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

export function parseJourney(rawJourney) {
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

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJson(value[key])]),
  );
}

function requestKey(method, url, body) {
  return JSON.stringify([method, url, stableJson(body)]);
}

function exchangeQueues(exchanges) {
  const queues = new Map();
  for (const item of exchanges) {
    const key = requestKey(item.method, item.url, item.body);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(item);
  }
  return queues;
}

async function fulfillRequest(route, site, journey, queues) {
  const request = route.request();
  const { origin: requestOrigin, pathname, search } = new URL(request.url());
  const method = request.method();
  if (requestOrigin !== origin) return false;
  if (["fetch", "xhr"].includes(request.resourceType())) {
    let body;
    if (request.postData() !== null) body = JSON.parse(request.postData());
    const recorded = queues.get(requestKey(method, pathname + search, body))?.shift();
    if (recorded) {
      const { status, response } = recorded;
      await route.fulfill(
        status === 204 || status === 205 ? { status } : { status, json: response },
      );
      return true;
    }
    if (method === "GET" && !search && Object.hasOwn(journey.responses, pathname)) {
      await route.fulfill({ json: journey.responses[pathname] });
      return true;
    }
  } else if (method === "GET") {
    const asset = await site.get(pathname, request.isNavigationRequest());
    if (asset) {
      await route.fulfill(asset);
      return true;
    }
    if (pathname === "/favicon.ico" && request.resourceType() === "other") {
      await route.fulfill({ status: 204 });
      return true;
    }
  }
  return false;
}

async function runJourney(browser, commit, site, journey, evidence) {
  const context = await browser.newContext({
    viewport,
    serviceWorkers: "block",
    acceptDownloads: false,
    reducedMotion: "reduce",
    timezoneId: "UTC",
    locale: "en-US",
    colorScheme: "light",
  });
  const unexpected = new Set();
  const queues = exchangeQueues(journey.exchanges);
  let stepNumber = 0;
  let action = "visit";
  let outcome;
  let screenshot;
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
        try {
          if (await fulfillRequest(route, site, journey, queues)) return;
        } catch {
          // Treat unreadable files and bodies as missing evidence.
        }
        const { origin: requestOrigin, pathname } = new URL(request.url());
        if (unexpected.size < 10)
          unexpected.add((request.method() + " " + requestOrigin + pathname).slice(0, 260));
        await route.abort();
      },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    try {
      await page.goto(origin + journey.start, { timeout: 8000 });
      for (const next of journey.steps) {
        if (unexpected.size) break;
        stepNumber++;
        action = next.action;
        if (action === "expectUrl") {
          await expect(page).toHaveURL(origin + next.url, { timeout: 3000 });
        } else if (action === "visit") {
          await page.goto(origin + next.url, { timeout: 8000 });
        } else {
          const locator = next.testId ? page.getByTestId(next.testId) : page.locator(next.selector);
          if (action === "click") await locator.click();
          else if (action === "fill") await locator.fill(next.value);
          else await expect(locator).toHaveText(next.text, { timeout: 3000 });
        }
      }
      outcome = { status: "PASSED", stepsCompleted: stepNumber };
    } catch (error) {
      outcome = {
        status: action.startsWith("expect") && error.matcherResult ? "FAILED" : "INCONCLUSIVE",
        step: stepNumber,
        action,
        diagnostic: stripVTControlCharacters(String(error.message)).slice(0, 1200),
      };
    }
    if (evidence && !page.isClosed()) {
      try {
        screenshot = await page.screenshot({
          animations: "disabled",
          caret: "hide",
          timeout: 3000,
        });
      } catch {
        outcome.screenshotUnavailable = true;
      }
    }
  } finally {
    await context.close();
  }
  const missing = [...queues.values()]
    .flat()
    .map(({ method, url }) => method + " " + url.split("?")[0]);
  return {
    screenshot,
    run: {
      commit,
      ...(site.buildSha256 ? { buildSha256: site.buildSha256 } : {}),
      ...(unexpected.size || missing.length
        ? {
            status: "INCONCLUSIVE",
            step: stepNumber,
            action,
            unrecordedRequests: [...unexpected],
            unusedFixtures: [...new Set(missing)],
          }
        : outcome),
    },
  };
}

export async function compareBrowserJourney(
  browser,
  directory,
  rawJourney,
  baselineCommit,
  candidateCommit,
  options = {},
) {
  const journey = parseJourney(rawJourney);
  if (baselineCommit === candidateCommit) throw Error("Select two different commits to compare.");
  const baselineSite = options.baselineBuild
    ? await readBuildSite(options.baselineBuild)
    : readCommitSite(directory, baselineCommit, journey.site);
  const candidateSite = options.candidateBuild
    ? await readBuildSite(options.candidateBuild)
    : readCommitSite(directory, candidateCommit, journey.site);
  const baseline = await runJourney(
    browser,
    baselineCommit,
    baselineSite,
    journey,
    options.evidence,
  );
  const candidate = await runJourney(
    browser,
    candidateCommit,
    candidateSite,
    journey,
    options.evidence,
  );
  const visual =
    options.evidence &&
    (await browserEvidence(browser, options.evidence, baseline.screenshot, candidate.screenshot));
  const outcomes = {
    "FAILED:PASSED": "FIXED",
    "PASSED:FAILED": "REGRESSION",
    "FAILED:FAILED": "STILL_FAILING",
    "PASSED:PASSED": "PASSED",
  };
  return {
    version: 1,
    journeySha256: createHash("sha256").update(rawJourney).digest("hex"),
    verdict: outcomes[baseline.run.status + ":" + candidate.run.status] ?? "INCONCLUSIVE",
    baseline: baseline.run,
    candidate: candidate.run,
    ...(visual ? { visual } : {}),
  };
}

export async function browserCompareCommand(args) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "baseline-build": { type: "string" },
      "candidate-build": { type: "string" },
      evidence: { type: "string" },
    },
  });
  const [file, baseline, candidate] = positionals;
  if (positionals.length !== 3 || !shaPattern.test(baseline) || !shaPattern.test(candidate))
    throw Error("Usage: traceyard compare-browser <journey.json> <baseline SHA> <candidate SHA>");
  if (Boolean(values["baseline-build"]) !== Boolean(values["candidate-build"]))
    throw Error(
      "Provide both build directories or supply both Git revisions in the current checkout.",
    );
  const journey = await readLimited(file, journeyLimit);
  const browser = await chromium.launch();
  try {
    const result = await compareBrowserJourney(
      browser,
      process.cwd(),
      journey,
      baseline,
      candidate,
      {
        baselineBuild: values["baseline-build"],
        candidateBuild: values["candidate-build"],
        evidence: values.evidence,
      },
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
        ...(result.visual ? ["Changed pixels: " + result.visual.changedPixels, ""] : []),
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
