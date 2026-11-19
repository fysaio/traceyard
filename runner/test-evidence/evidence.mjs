import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SaxesParser } from "saxes";
import { sanitizeDiagnostic } from "../../agent/test-report.mjs";

export const revisionPattern = /^[a-f0-9]{40}$/;
export const lanePattern = /^[a-z0-9][a-z0-9_-]{0,59}$/;
export const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;
export const maxReportBytes = 4 * 1024 * 1024;
const maxCases = 10000;
const statuses = new Set(["passed", "failed", "error", "skipped", "ambiguous"]);
const failing = (status) => status === "failed" || status === "error";
const executed = (status) => status === "passed" || failing(status);

function publicLabel(value, limit) {
  return sanitizeDiagnostic(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    limit,
  ).replace(/[\p{Cc}\p{Cf}]/gu, "");
}

function repoFile(value, root) {
  const path = String(value ?? "").replaceAll("\\", "/");
  const prefix = root.replaceAll("\\", "/").replace(/\/+$/, "") + "/";
  const windows = /^[a-z]:\//i.test(prefix);
  const within = windows
    ? path.toLowerCase().startsWith(prefix.toLowerCase())
    : path.startsWith(prefix);
  const local = (within ? path.slice(prefix.length) : path).replace(/^\.\//, "");
  if (
    !/^[\w@./ -]{1,250}$/.test(local) ||
    local.startsWith("/") ||
    local.split("/").some((part) => part === ".." || part === "." || !part)
  )
    return "";
  return local;
}

function identity(fields) {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export function readJUnit(xml, source, root) {
  const cases = [];
  const parser = new SaxesParser();
  const stack = [];
  let testcase;
  let seenRoot = false;
  parser.on("doctype", () => {
    throw Error("JUnit reports must not contain a DOCTYPE.");
  });
  parser.on("opentag", (tag) => {
    if (!stack.length) {
      if (!["testsuite", "testsuites"].includes(tag.name))
        throw Error("Expected a JUnit document.");
      seenRoot = true;
    }
    if (stack.length >= 64) throw Error("JUnit nesting exceeds the report limit.");
    const parent = stack.at(-1);
    if (tag.name === "testcase") {
      if (parent?.name !== "testsuite" || testcase) throw Error("Invalid JUnit testcase nesting.");
      const title = tag.attributes.name;
      if (!title?.trim()) throw Error("JUnit testcase is missing a name.");
      const file =
        repoFile(tag.attributes.file || parent.attributes.file, root) ||
        [tag.attributes.classname, parent.attributes.name]
          .map((value) => repoFile(value, root))
          .find((value) => /\.[a-z0-9]{1,8}$/i.test(value) && value.includes("/")) ||
        "";
      const fields = [
        source,
        publicLabel(
          stack
            .filter((node) => node.name === "testsuite")
            .map((node) => node.attributes.name || "")
            .join(" / "),
          180,
        ),
        publicLabel(tag.attributes.classname, 180),
        publicLabel(title, 250),
        file,
      ];
      const [, suite, className, name] = fields;
      testcase = { id: identity(fields), source, suite, className, name, file, status: "passed" };
    } else if (parent?.name === "testcase" && testcase) {
      if (tag.name === "error") testcase.status = "error";
      if (tag.name === "failure" && testcase.status !== "error") testcase.status = "failed";
      if (tag.name === "skipped" && testcase.status === "passed") testcase.status = "skipped";
    }
    stack.push(tag);
  });
  parser.on("closetag", (tag) => {
    stack.pop();
    if (tag.name === "testcase" && testcase) {
      cases.push(testcase);
      testcase = undefined;
      if (cases.length > maxCases) throw Error("JUnit test count exceeds the report limit.");
    }
  });
  parser.write(xml).close();
  if (!seenRoot) throw Error("Expected a JUnit document.");
  return cases;
}

export async function readReports(directory, root) {
  const records = new Map();
  let files = 0;
  let bytes = 0;
  let total = 0;
  let duplicates = 0;
  const observations = { passed: 0, failed: 0, error: 0, skipped: 0 };
  async function walk(relative) {
    const children = await readdir(join(directory, relative), { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = (relative ? relative + "/" : "") + child.name;
      if (child.isDirectory()) {
        if (path.split("/").length > 8) throw Error("Report directories are too deeply nested.");
        await walk(path);
      }
      if (!child.isFile() || !path.endsWith(".xml")) continue;
      const location = join(directory, path);
      const { size } = await lstat(location);
      bytes += size;
      if (++files > 100 || bytes > 16 * 1024 * 1024)
        throw Error("JUnit inputs exceed the report limit.");
      let parsed;
      try {
        parsed = readJUnit(await readFile(location, "utf8"), publicLabel(path, 200), root);
      } catch {
        throw Error(
          "Invalid JUnit XML in " + publicLabel(path, 200) + ". Check the reporter output.",
        );
      }
      for (const test of parsed) {
        if (++total > maxCases) throw Error("JUnit test count exceeds the report limit.");
        observations[test.status]++;
        const previous = records.get(test.id);
        if (previous) {
          duplicates++;
          previous.status = "ambiguous";
        } else records.set(test.id, test);
      }
    }
  }
  await walk("");
  if (!records.size) throw Error("No test cases were found in the JUnit reports.");
  return { tests: [...records.values()], files, duplicates, observations };
}

export function validateHistory(value, repository, lane, runId, attempt) {
  if (
    value?.version !== 1 ||
    value.repository !== repository ||
    value.lane !== lane ||
    value.runId !== runId ||
    value.attempt !== attempt ||
    !revisionPattern.test(value.sha) ||
    !Array.isArray(value.tests) ||
    value.tests.length < 1 ||
    value.tests.length > maxCases
  )
    throw Error("Invalid prior evidence.");
  const seen = new Set();
  for (const test of value.tests) {
    if (!test || !/^[a-f0-9]{64}$/.test(test.id) || !statuses.has(test.status) || seen.has(test.id))
      throw Error("Invalid prior test outcome.");
    seen.add(test.id);
  }
  return value;
}

export function compareTests(tests, sha, snapshots) {
  const current = new Map(tests.map((test) => [test.id, test]));
  const history = new Map();
  for (const { report, baseline } of snapshots) {
    for (const prior of report.tests) {
      if (!current.has(prior.id) || !executed(prior.status)) continue;
      const state = history.get(prior.id) ?? {};
      if (baseline && !state.baseline)
        state.baseline = { status: prior.status, runId: report.runId, sha: report.sha };
      if (sha === report.sha) {
        const key = failing(prior.status) ? "failed" : "passed";
        state[key] ??= report.runId;
      }
      history.set(prior.id, state);
    }
  }
  const counts = { passed: 0, failed: 0, error: 0, skipped: 0, ambiguous: 0 };
  const findings = [];
  for (const test of tests) {
    counts[test.status]++;
    const previous = history.get(test.id) ?? {};
    const isFailure = failing(test.status);
    const opposite = executed(test.status) && (isFailure ? previous.passed : previous.failed);
    if (opposite) findings.push({ ...test, finding: "intermittent", priorRunId: opposite });
    else if (isFailure) {
      const prior = previous.baseline;
      const finding = !prior
        ? "no-baseline"
        : failing(prior.status)
          ? "known-failure"
          : "new-failure";
      findings.push({
        ...test,
        finding,
        ...(prior ? { priorRunId: prior.runId, priorSha: prior.sha } : {}),
      });
    }
  }
  return { counts, findings };
}
