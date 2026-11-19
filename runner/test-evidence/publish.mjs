import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compareTests,
  lanePattern,
  maxReportBytes,
  readReports,
  repositoryPattern,
  revisionPattern,
} from "./evidence.mjs";
import { githubHistory } from "./history.mjs";

const labels = {
  "new-failure": "New failure",
  intermittent: "Intermittent",
  "known-failure": "Previously failing",
  "no-baseline": "No baseline",
};
const findingOrder = Object.keys(labels);
const inline = (value) =>
  String(value)
    .replace(/[&<>[\]{}\\|*~_()!]/g, (char) => "&#" + char.charCodeAt(0) + ";")
    .replaceAll(String.fromCharCode(96), "&#96;");

function renderSummary(report) {
  const { counts, observations, history, repository, duplicates, files, findings, sha, lane } =
    report;
  const rows = [
    "",
    "## Traceyard test evidence",
    "",
    "Tested commit **" + sha + "** on **" + inline(lane) + "**.",
    "",
    "Passed **" +
      observations.passed +
      "** · Failed **" +
      (observations.failed + observations.error) +
      "** · Skipped **" +
      observations.skipped +
      "** · Ambiguous test identities **" +
      counts.ambiguous +
      "**.",
    "",
    "Read " + files + " JUnit reports. Compared " + history.compared + " earlier snapshots.",
  ];
  if (report.testOutcome === "failure")
    rows.push("The test step failed. These totals cover the reports it wrote.");
  if (history.status !== "available") rows.push("GitHub history was " + history.status + ".");
  if (duplicates)
    rows.push(
      "Found " +
        duplicates +
        " duplicate test entries. They are included in the totals and excluded from history comparisons.",
    );
  const displayed = [...findings].sort(
    (a, b) => findingOrder.indexOf(a.finding) - findingOrder.indexOf(b.finding),
  );
  if (displayed.length) {
    rows.push("", "| Result | Test | Source file | Evidence |", "| --- | --- | --- | --- |");
    for (const item of displayed.slice(0, 35)) {
      const name = [...new Set([item.suite, item.className, item.name].filter(Boolean))].join(
        " / ",
      );
      const path = item.file ? inline(item.file) : "—";
      const previous = item.priorRunId
        ? "[Prior CI run](https://github.com/" +
          repository +
          "/actions/runs/" +
          item.priorRunId +
          ")"
        : "—";
      rows.push(
        "| " + labels[item.finding] + " | " + inline(name) + " | " + path + " | " + previous + " |",
      );
    }
    if (displayed.length > 35)
      rows.push("", "Download the JSON artifact for the remaining findings.");
  }
  if (findings.some(({ file }) => file))
    rows.push(
      "",
      "To investigate an npm test in Traceyard, start with its source file and the tested commit above.",
    );
  return rows.join("\n") + "\n";
}

async function main() {
  const env = process.env;
  const meta = {
    version: 1,
    repository: env.GITHUB_REPOSITORY ?? "",
    sha: env.TRACEYARD_TESTED_SHA ?? "",
    lane: env.TRACEYARD_TEST_LANE ?? "",
    runId: Number(env.GITHUB_RUN_ID) || 0,
    attempt: Number(env.GITHUB_RUN_ATTEMPT) || 1,
  };
  const directory = env.TRACEYARD_TEST_REPORTS;
  const outputDirectory = env.TRACEYARD_TEST_OUTPUT;
  if (
    !repositoryPattern.test(meta.repository) ||
    !revisionPattern.test(meta.sha) ||
    !lanePattern.test(meta.lane) ||
    !directory ||
    !outputDirectory ||
    !Number.isSafeInteger(meta.attempt) ||
    meta.attempt < 1 ||
    !Number.isSafeInteger(meta.runId) ||
    meta.runId < 0
  )
    throw Error(
      "Provide a repository, exact tested SHA, CI lane, report directory, and output directory.",
    );
  const source = await readReports(directory, env.GITHUB_WORKSPACE ?? process.cwd());
  const history = await githubHistory(meta, env.TRACEYARD_TEST_BASELINE, env.TRACEYARD_TEST_TOKEN);
  const report = {
    ...meta,
    ...source,
    testOutcome: ["success", "failure"].includes(env.TRACEYARD_TEST_OUTCOME)
      ? env.TRACEYARD_TEST_OUTCOME
      : "unknown",
    ...compareTests(source.tests, meta.sha, history.snapshots),
    history: { status: history.status, compared: history.snapshots.length },
  };
  const body = JSON.stringify(report);
  if (Buffer.byteLength(body) > maxReportBytes)
    throw Error("The normalized evidence exceeds the artifact limit.");
  await mkdir(outputDirectory, { recursive: true });
  const file = join(outputDirectory, "report.json");
  await writeFile(file, body + "\n");
  const summary = renderSummary(report);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary);
  else console.log(summary);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, "report=" + file + "\n");
}

main().catch((error) => {
  console.error("Traceyard test evidence could not be published. " + error.message);
  process.exitCode = 1;
});
