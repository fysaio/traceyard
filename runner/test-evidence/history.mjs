import { URLSearchParams } from "node:url";
import { TextDecoder } from "node:util";
import { unzipSync } from "fflate";
import { maxReportBytes, validateHistory } from "./evidence.mjs";

const origin = "https://api.github.com";
const archiveLimit = 2 * 1024 * 1024;
const runLimit = 6;
const attemptPattern = /^[1-9][0-9]{0,5}$/;

async function readArchive(response) {
  if (!response.ok || !response.body) throw Error("Evidence archive is unavailable.");
  const parts = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > archiveLimit) throw Error("Evidence archive exceeds the limit.");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts, total);
}

export async function githubHistory(report, branch, token, request = fetch) {
  const result = { status: "unavailable", snapshots: [], incomplete: false };
  if (!token || !branch || !report.runId) return result;
  const repo = report.repository.split("/").map(encodeURIComponent).join("/");
  const endpoint = origin + "/repos/" + repo + "/actions";
  const call = (path) =>
    request(endpoint + path, {
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
  const json = async (path) => {
    const response = await call(path);
    if (!response.ok) throw Error("GitHub Actions history is unavailable.");
    return response.json();
  };
  try {
    const current = await json("/runs/" + report.runId);
    if (!Number.isSafeInteger(current.workflow_id) || !/^[a-f0-9]{40}$/.test(current.head_sha))
      throw Error("Invalid current GitHub run.");
    const path = "/workflows/" + current.workflow_id + "/runs?";
    const runs = ({ onlyBranch, sha }) =>
      json(
        path +
          new URLSearchParams({
            ...(onlyBranch ? { branch: onlyBranch, event: "push" } : {}),
            ...(sha ? { head_sha: sha } : {}),
            status: "completed",
            per_page: String(runLimit),
          }),
      );
    const [baseline, matching] = await Promise.allSettled([
      runs({ onlyBranch: branch }),
      runs({ sha: current.head_sha }),
    ]);
    result.incomplete = baseline.status === "rejected" || matching.status === "rejected";
    if (baseline.status === "rejected" && matching.status === "rejected" && report.attempt === 1)
      return result;
    const candidates = new Map();
    const add = (run, baseline) => {
      if (!Number.isSafeInteger(run.id) || run.id <= 0 || run.id >= report.runId) return;
      candidates.set(run.id, { id: run.id, baseline, maxAttempt: 1000000 });
    };
    for (const run of matching.value?.workflow_runs ?? []) add(run, false);
    for (const run of baseline.value?.workflow_runs ?? []) {
      if (run.head_branch === branch && run.event === "push") add(run, true);
    }
    if (report.attempt > 1)
      candidates.set(report.runId, {
        id: report.runId,
        maxAttempt: report.attempt - 1,
        baseline: false,
      });
    const pattern = "traceyard-test-evidence-" + report.lane + "-";
    const work = [...candidates.values()].sort((a, b) => b.id - a.id);
    const listed = await Promise.allSettled(
      work.map(async (run) => {
        const { artifacts } = await json("/runs/" + run.id + "/artifacts?per_page=100");
        return artifacts
          .filter(
            (artifact) =>
              !artifact.expired &&
              artifact.name?.startsWith(pattern) &&
              Number.isSafeInteger(artifact.id) &&
              artifact.id > 0,
          )
          .map((artifact) => ({ artifact, attemptText: artifact.name.slice(pattern.length) }))
          .filter(
            ({ attemptText }) =>
              attemptPattern.test(attemptText) && Number(attemptText) <= run.maxAttempt,
          )
          .map(({ artifact, attemptText }) => ({ ...run, artifact, attempt: Number(attemptText) }))
          .sort((a, b) => b.attempt - a.attempt)
          .slice(0, 3);
      }),
    );
    const available = listed.flatMap((row) => (row.status === "fulfilled" ? row.value : []));
    result.incomplete ||= listed.some((row) => row.status === "rejected");
    const downloaded = await Promise.allSettled(
      available.slice(0, 30).map(async (row) => {
        if (row.artifact.size_in_bytes > archiveLimit)
          throw Error("Evidence archive exceeds the limit.");
        const response = await call("/artifacts/" + row.artifact.id + "/zip");
        const redirect = new URL(response.headers.get("location") ?? "", origin);
        if (
          response.status !== 302 ||
          redirect.protocol !== "https:" ||
          redirect.username ||
          redirect.password ||
          redirect.origin === origin
        )
          throw Error("Unexpected evidence archive URL.");
        const signed = await request(redirect.href, {
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        const entries = unzipSync(await readArchive(signed), {
          filter: (entry) => entry.name === "report.json" && entry.originalSize <= maxReportBytes,
        });
        const bytes = entries["report.json"];
        if (!bytes || bytes.byteLength > maxReportBytes)
          throw Error("Saved evidence is missing or too large.");
        const prior = validateHistory(
          JSON.parse(new TextDecoder().decode(bytes)),
          report.repository,
          report.lane,
          row.id,
          row.attempt,
        );
        return { baseline: row.baseline, report: prior };
      }),
    );
    result.incomplete ||= downloaded.some((row) => row.status === "rejected");
    result.snapshots = downloaded.flatMap((row) => (row.status === "fulfilled" ? [row.value] : []));
    result.status = !result.incomplete ? "available" : "partial";
    return result;
  } catch {
    return result;
  }
}
