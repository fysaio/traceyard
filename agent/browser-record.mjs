/* global window, document, CSS, Element, location, HTMLInputElement, HTMLTextAreaElement */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { viewport } from "./browser-evidence.mjs";
import { parseJourney } from "./browser-journey.mjs";

function installRecorder({ inputs }) {
  if (window !== window.top) return;
  let picking = false;
  const send = (step) => window.__traceyardRecord(step).catch(() => {});
  const unique = (element, selector) =>
    document.querySelectorAll(selector).length === 1 && element.matches(selector);
  const attribute = (key, value) => "[" + key + '="' + CSS.escape(value) + '"]';
  function locate(element) {
    for (const key of ["data-testid", "id", "role", "name", "aria-label"]) {
      const value = element.getAttribute(key);
      if (value && unique(element, attribute(key, value)))
        return key === "data-testid" ? { testId: value } : { selector: attribute(key, value) };
    }
    const parts = [];
    for (let el = element; el && el !== document.body; el = el.parentElement) {
      const siblings = [...el.parentElement.children].filter(
        (sibling) => sibling.tagName === el.tagName,
      );
      parts.unshift(el.localName + ":nth-of-type(" + (siblings.indexOf(el) + 1) + ")");
    }
    return { selector: ["body", ...parts].join(" > ") };
  }
  window.addEventListener("DOMContentLoaded", () => {
    const frame = document.createElement("traceyard-recorder");
    frame.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647";
    const panel = frame.attachShadow({ mode: "open" });
    panel.innerHTML = [
      "<style>div{background:#101114;color:#fff;padding:10px;border-radius:9px;font:14px system-ui;box-shadow:0 2px 14px #0005}",
      "button{font:inherit;margin:4px;padding:6px;cursor:pointer}p{margin:2px 4px}</style>",
      '<div><p role="status">Recording</p>',
      '<button type="button" id="text">Assert text</button><button type="button" id="url">Assert URL</button>',
      '<button type="button" id="save">Save journey</button></div>',
    ].join("");
    const status = panel.querySelector("p");
    panel.querySelector("#text").onclick = () => {
      picking = !picking;
      status.textContent = picking ? "Click the text you want to check" : "Recording";
    };
    panel.querySelector("#url").onclick = () =>
      send({ action: "expectUrl", url: location.pathname + location.search });
    panel.querySelector("#save").onclick = () => send({ action: "save" });
    document.addEventListener(
      "click",
      (event) => {
        if (event.target === frame || !(event.target instanceof Element) || !event.isTrusted)
          return;
        if (picking) {
          picking = false;
          event.preventDefault();
          event.stopImmediatePropagation();
          const text = event.target.textContent.trim().replace(/\s+/g, " ");
          if (text) send({ action: "expectText", ...locate(event.target), text });
          status.textContent = text ? "Text assertion added" : "Choose an element with text";
        } else {
          const target =
            event.target.closest("button,a,[role=button],[role=link],summary,label") ??
            event.target;
          if (
            !target.matches("input,textarea,select") &&
            !target.control?.matches("input:not([type=checkbox]):not([type=radio]),textarea,select")
          )
            send({ action: "click", ...locate(target) });
          else if (target.matches("input[type=checkbox],input[type=radio]"))
            send({ action: "click", ...locate(target) });
        }
      },
      true,
    );
    document.addEventListener(
      "change",
      (event) => {
        const element = event.target;
        if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type))
          return;
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          send({ action: "unsupportedInput" });
          return;
        }
        if (
          !inputs ||
          ["password", "file", "hidden"].includes(element.type) ||
          /password|one-time|credit|cc-|token|secret/i.test(
            (element.name ?? "") + " " + element.autocomplete,
          )
        ) {
          send({ action: "unsupportedInput" });
          return;
        }
        send({ action: "fill", ...locate(element), value: element.value });
      },
      true,
    );
    document.documentElement.append(frame);
  });
}

export async function startBrowserRecorder(browser, start, { paths, site, inputs }) {
  if (
    !["http:", "https:"].includes(start.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(start.hostname) ||
    start.username ||
    start.password ||
    start.hash
  )
    throw Error("Record a local test app URL with no embedded credentials or fragment.");
  const context = await browser.newContext({
    viewport,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  const steps = [];
  const issues = new Set();
  const pending = new Map();
  const pathsSeen = new Set();
  const exchanges = [];
  const requestOrder = new WeakMap();
  const inFlight = new Set();
  let sequence = 0;
  let usedBytes = 0;
  let finish;
  let cancel;
  const completed = new Promise((resolve, reject) => {
    finish = resolve;
    cancel = reject;
  });
  // Closing the browser or intentionally discarding a recording can happen before the caller awaits it.
  completed.catch(() => {});
  context.once("close", () => cancel(Error("Recording ended before the journey was saved.")));
  try {
    await context.routeWebSocket(
      () => true,
      async (socket) => {
        issues.add("The app opened a WebSocket.");
        await socket.close();
      },
    );
    await context.route(
      () => true,
      async (route) => {
        const request = route.request();
        const { origin, pathname } = new URL(request.url());
        if (origin !== start.origin) {
          issues.add("The app requested an external origin.");
          await route.abort();
        } else if (["fetch", "xhr"].includes(request.resourceType()) && !paths.has(pathname)) {
          issues.add("Explicitly allow the endpoint " + pathname + " to record its response.");
          await route.abort();
        } else if (request.isNavigationRequest() && request.method() !== "GET") {
          issues.add("Direct form submission is unsupported. Use an app with a JSON test API.");
          await route.abort();
        } else {
          try {
            const response = await route.fetch({ maxRedirects: 0, timeout: 10000 });
            const location = response.headers().location;
            if (response.status() >= 300 && response.status() < 400 && location) {
              issues.add(
                "Redirects are unsupported during recording. Start at the final local URL.",
              );
              await route.abort();
            } else {
              await route.fulfill({ response });
            }
          } catch {
            issues.add("The local app did not respond for " + pathname + ".");
            await route.abort();
          }
        }
      },
    );
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin === start.origin &&
        paths.has(url.pathname) &&
        ["fetch", "xhr"].includes(request.resourceType())
      ) {
        requestOrder.set(request, sequence++);
        inFlight.add(request);
      }
    });
    context.on("requestfinished", (request) => inFlight.delete(request));
    context.on("requestfailed", (request) => {
      if (inFlight.delete(request)) issues.add("An approved API request failed during recording.");
    });
    context.on("response", (response) => {
      const request = response.request();
      const order = requestOrder.get(request);
      if (order === undefined) return;
      const url = new URL(request.url());
      if (exchanges.length >= 80) {
        issues.add("The journey exceeds 80 recorded responses.");
        return;
      }
      pathsSeen.add(url.pathname);
      const exchange = {
        method: request.method(),
        url: url.pathname + url.search,
        status: response.status(),
      };
      exchanges.push({ order, exchange });
      const capture = async () => {
        try {
          if (request.postData() !== null) exchange.body = JSON.parse(request.postData());
          const noBody = [204, 205].includes(exchange.status);
          if (!noBody && !(response.headers()["content-type"] ?? "").includes("application/json"))
            throw Error();
          const bytes = noBody ? Buffer.from("null") : await response.body();
          usedBytes += bytes.length;
          if (usedBytes > 192 * 1024) throw Error();
          exchange.response = JSON.parse(bytes.toString("utf8"));
        } catch {
          issues.add("Unable to capture a bounded JSON response for " + url.pathname + ".");
        }
      };
      pending.set(
        exchange,
        capture().finally(() => pending.delete(exchange)),
      );
    });
    const page = await context.newPage();
    await context.exposeBinding("__traceyardRecord", async ({ frame, page: sender }, item) => {
      if (
        sender !== page ||
        frame !== page.mainFrame() ||
        new URL(frame.url()).origin !== start.origin
      )
        return;
      if (item.action === "save") {
        try {
          const deadline = Date.now() + 2000;
          while (inFlight.size && Date.now() < deadline)
            await context.waitForEvent("requestfinished", {
              predicate: (request) => requestOrder.has(request),
              timeout: Math.max(1, deadline - Date.now()),
            });
        } catch {
          if (inFlight.size) issues.add("An approved API request did not finish before saving.");
        }
        if (inFlight.size) issues.add("An approved API request did not finish before saving.");
        if (issues.size) return cancel(Error([...issues].join(" ")));
        await Promise.all(pending.values());
        for (const path of paths)
          if (!pathsSeen.has(path)) issues.add("No response captured for " + path + ".");
        if (issues.size) return cancel(Error([...issues].join(" ")));
        const raw = JSON.stringify(
          {
            version: 1,
            site,
            start: start.pathname + start.search,
            steps,
            exchanges: exchanges.sort((a, b) => a.order - b.order).map(({ exchange }) => exchange),
          },
          null,
          2,
        );
        try {
          parseJourney(raw);
          finish(raw);
        } catch (error) {
          cancel(error);
        }
      } else if (item.action === "unsupportedInput") {
        issues.add(
          "The journey contains an unrecorded input. Use test text with --inputs or remove that step.",
        );
      } else if (steps.length < 40) {
        steps.push(item);
      } else {
        issues.add("The journey exceeds 40 steps.");
      }
    });
    await context.addInitScript(installRecorder, { inputs });
    await page.goto(start.href, { timeout: 15000 });
    return { completed, page, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function browserRecordCommand(args) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      capture: { type: "string", multiple: true },
      site: { type: "string", default: "dist" },
      inputs: { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 2)
    throw Error(
      "Usage: traceyard record-browser <local URL> <journey.json> [--capture /api/path] [--inputs]",
    );
  const [url, output] = positionals;
  const paths = new Set(values.capture);
  for (const path of paths) {
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith("//"))
      throw Error("Use a same-origin API pathname.");
  }
  console.log(
    "Use test data only. Review the saved assertions and response bodies before committing.",
  );
  const browser = await chromium.launch({ headless: false });
  try {
    const recording = await startBrowserRecorder(browser, new URL(url), {
      paths,
      site: values.site,
      inputs: values.inputs,
    });
    try {
      const journey = await recording.completed;
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, journey + "\n", { flag: "wx", mode: 0o600 });
      console.log("Saved " + output);
    } finally {
      await recording.close();
    }
  } finally {
    await browser.close();
  }
}
