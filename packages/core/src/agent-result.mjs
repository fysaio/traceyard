// The response envelope every Traceyard MCP tool returns, hosted or local.
// One implementation, so both servers bound output the same way.
//
// `limit` is a budget in bytes of UTF-16 (two per character) plus a fixed
// overhead, matching the hosted `outputChars` argument. Fields are dropped in a
// fixed order until the packet fits, and `omitted` says whether anything was.

const OPTIONAL_ARRAYS = [
  "items",
  "evidence",
  "attempts",
  "recordings",
  "verifications",
  "limitations",
];
const DROPPABLE = [
  "recordings",
  "verifications",
  "snapshot",
  "limitations",
  "attempts",
  "evidence",
  "items",
  "nextAction",
  "browserUrl",
];

function compactVerification(packet, size, limit) {
  const v = packet.verification;
  packet.verification = {
    id: v.id,
    baselineId: v.baselineId,
    candidateId: v.candidateId,
    verdict: v.verdict,
    label: v.label,
    evidence: [v.baselineRun, v.candidateRun].map((run) => {
      if (!run || typeof run !== "object") return null;
      const { commit, evidenceId, status } = run;
      return { commit, evidenceId, status };
    }),
    changedTestsCount: Array.isArray(v.changedTests) ? v.changedTests.length : 0,
    changedTests: Array.isArray(v.changedTests) ? v.changedTests.slice(0, 5) : [],
    metrics: v.metrics,
  };
  if (Array.isArray(v.changedTests) && v.changedTests.length > 5) packet.omitted = true;
  const compact = packet.verification;
  while (size() > limit && compact.changedTests.length) {
    compact.changedTests.pop();
    packet.omitted = true;
  }
  if (size() > limit) {
    delete compact.metrics;
    packet.omitted = true;
  }
  if (size() > limit) {
    compact.evidence = compact.evidence.map((item) => item?.evidenceId ?? null);
    packet.omitted = true;
  }
}

/**
 * Local runs: shorten failure messages, then drop logs, then keep only the
 * first failure. The evidence ID stays, so nothing is lost for good.
 */
function compactRuns(packet, size, limit) {
  const runs = packet.runs;
  for (const length of [300, 120]) {
    if (size() <= limit) return;
    for (const run of runs)
      for (const failure of run.failures ?? [])
        if (failure.message?.length > length) {
          failure.message = failure.message.slice(0, length);
          run.truncated = true;
          packet.omitted = true;
        }
  }
  for (const run of runs)
    if (size() > limit && "output" in run) {
      delete run.output;
      packet.omitted = true;
    }
  for (const run of runs)
    while (size() > limit && run.failures?.length > 1) {
      run.failures.pop();
      run.truncated = true;
      packet.omitted = true;
    }
}

export function agentResult(value, limit = 4000) {
  const packet = { schemaVersion: 1, ...JSON.parse(JSON.stringify(value)), omitted: false };
  const size = () => JSON.stringify(packet).length * 2 + 200;
  if (packet.verification && typeof packet.verification === "object")
    compactVerification(packet, size, limit);
  if (Array.isArray(packet.runs)) compactRuns(packet, size, limit);
  if (packet.explanation?.source && size() > limit) {
    packet.explanation.source = null;
    packet.omitted = true;
  }
  for (const key of OPTIONAL_ARRAYS) {
    const array = packet[key];
    if (Array.isArray(array))
      while (array.length > 1 && size() > limit) {
        array.pop();
        packet.omitted = true;
      }
  }
  for (const key of DROPPABLE) {
    if (size() <= limit) break;
    if (key in packet) {
      delete packet[key];
      packet.omitted = true;
    }
  }
  while (size() > limit && typeof packet.summary === "string" && packet.summary.length > 20) {
    packet.summary = packet.summary.slice(
      0,
      Math.max(20, Math.floor(packet.summary.length * 0.75)),
    );
    packet.omitted = true;
  }
  if (packet.omitted && typeof packet.offset === "number" && typeof packet.summary === "string")
    packet.nextOffset = packet.offset + packet.summary.length;
  return {
    content: [{ type: "text", text: JSON.stringify(packet) }],
    structuredContent: packet,
  };
}
