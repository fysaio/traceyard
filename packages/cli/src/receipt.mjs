import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VERSION } from "./version.mjs";
import { compactFailure } from "./compact.mjs";

const receiptsDir = (stateDir) => join(stateDir, "receipts");
const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : value;
/** Stable JSON with sorted keys at every level, so the digest doesn't depend on key order. */
const canonical = (value) => JSON.stringify(sorted(value));

const runSummary = (run) => ({
  commit: run.commit,
  status: run.status,
  counts: run.counts,
  failures: run.failures.map(({ name, message }) => ({
    name,
    message: compactFailure(message).slice(0, 600),
  })),
  durationMs: run.durationMs,
});

/**
 * Write a verification receipt as JSON and Markdown under .traceyard/receipts.
 * Trust level is "local": it was produced on this machine and is evidence for
 * the developer and their agent, not a signed CI attestation.
 */
export async function writeReceipt(stateDir, { repository, test, verdict, baseline, candidate }) {
  const createdAt = new Date().toISOString();
  const id =
    "rcpt_" + createdAt.replace(/[-:.TZ]/g, "").slice(0, 17) + "_" + randomBytes(3).toString("hex");
  const body = {
    schemaVersion: 1,
    id,
    createdAt,
    trust: "local",
    tool: { name: "traceyard", version: VERSION },
    environment: { node: process.version, platform: process.platform + "-" + process.arch },
    repository,
    test,
    verdict: verdict.verdict,
    summary: verdict.summary,
    baseline: runSummary(baseline),
    candidate: runSummary(candidate),
    changedTests: verdict.changedTests,
  };
  const receipt = {
    ...body,
    digest: "sha256:" + createHash("sha256").update(canonical(body)).digest("hex"),
  };
  await mkdir(receiptsDir(stateDir), { recursive: true });
  const jsonPath = join(receiptsDir(stateDir), id + ".json");
  const markdownPath = join(receiptsDir(stateDir), id + ".md");
  await writeFile(jsonPath, JSON.stringify(receipt, null, 2) + "\n");
  await writeFile(markdownPath, receiptMarkdown(receipt));
  return { receipt, jsonPath, markdownPath };
}

const counts = (c) => `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped`;

export function receiptMarkdown(r) {
  const lines = [
    `## Traceyard receipt: ${r.verdict}`,
    "",
    r.summary,
    "",
    "| | Commit | Result |",
    "| --- | --- | --- |",
    `| Before (failing) | \`${r.baseline.commit}\` | ${r.baseline.status}: ${counts(r.baseline.counts)} |`,
    `| After (fix) | \`${r.candidate.commit}\` | ${r.candidate.status}: ${counts(r.candidate.counts)} |`,
    "",
    `- **Test:** \`${r.test.path}\`${r.test.case ? ` (case \`${r.test.case}\`)` : ""}`,
  ];
  if (r.repository) lines.push(`- **Repository:** ${r.repository}`);
  lines.push(
    `- **Test files changed between commits:** ${r.changedTests.length ? r.changedTests.map((p) => "`" + p + "`").join(", ") : "none"}`,
  );
  if (r.baseline.failures[0])
    lines.push(
      "",
      "Failure at the failing commit:",
      "",
      "```",
      `${r.baseline.failures[0].name}`,
      r.baseline.failures[0].message,
      "```",
    );
  lines.push(
    "",
    `Trust: **${r.trust}**. Ran on ${r.environment.platform} with Node ${r.environment.node} and traceyard ${r.tool.version}, ${r.createdAt}.`,
    `Receipt \`${r.id}\`, digest \`${r.digest}\`.`,
    "",
  );
  return lines.join("\n");
}

/** Load a receipt by id, or the newest one when id is omitted. */
export async function readReceipt(stateDir, id) {
  let name = id;
  if (!name) {
    const files = (await readdir(receiptsDir(stateDir)).catch(() => []))
      .filter((f) => f.endsWith(".json"))
      .sort();
    name = files.at(-1)?.replace(/\.json$/, "");
    if (!name) return null;
  }
  if (!/^rcpt_[0-9]{17}_[a-f0-9]{6}$/.test(name)) return null;
  try {
    const receipt = JSON.parse(await readFile(join(receiptsDir(stateDir), name + ".json"), "utf8"));
    const { digest, ...body } = receipt;
    const intact =
      digest === "sha256:" + createHash("sha256").update(canonical(body)).digest("hex");
    return { receipt, intact, jsonPath: join(receiptsDir(stateDir), name + ".json") };
  } catch {
    return null;
  }
}

/** Newest receipts first, without checking digests. */
export async function listReceipts(stateDir, limit = 5) {
  const files = (await readdir(receiptsDir(stateDir)).catch(() => []))
    .filter((f) => /^rcpt_[0-9]{17}_[a-f0-9]{6}\.json$/.test(f))
    .sort()
    .reverse()
    .slice(0, limit);
  const receipts = [];
  for (const file of files)
    try {
      receipts.push(JSON.parse(await readFile(join(receiptsDir(stateDir), file), "utf8")));
    } catch {
      // Skip unreadable receipts; `traceyard receipt <id>` reports them.
    }
  return receipts;
}
