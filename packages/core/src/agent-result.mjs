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
    // Evidence state, claim, scope, source and revision are never dropped.
    ...(v.evidence && typeof v.evidence === "object"
      ? {
          claim: {
            evidenceId: v.evidence.evidenceId,
            state: v.evidence.state,
            claim: v.evidence.claim,
            scope: v.evidence.scope,
            source: v.evidence.source,
            commit: v.evidence.revision?.commit ?? null,
            limitations: Array.isArray(v.evidence.limitations)
              ? v.evidence.limitations.slice(0, 3)
              : [],
          },
        }
      : {}),
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
  while (size() > limit && compact.claim?.limitations.length > 1) {
    compact.claim.limitations.pop();
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
  // The claim summary is never dropped; only its limitations shorten, to one.
  const claimNotes = packet.claim?.limitations;
  if (Array.isArray(claimNotes))
    while (claimNotes.length > 1 && size() > limit) {
      claimNotes.pop();
      packet.omitted = true;
    }
  if (Array.isArray(claimNotes) && claimNotes[0]?.length > 160 && size() > limit) {
    claimNotes[0] = claimNotes[0].slice(0, 160);
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
  // Last resort before cutting the summary: diagnostic run fields, then the
  // claim's copy of an evidence ID that a run already carries. The claim's
  // state, scope, source and revision are never removed.
  if (Array.isArray(packet.runs))
    for (const field of ["durationMs", "dependencies", "cached", "workingTree", "message"])
      for (const run of packet.runs)
        if (size() > limit && run && typeof run === "object" && field in run) {
          delete run[field];
          packet.omitted = true;
        }
  if (Array.isArray(packet.runs) && typeof packet.test?.path === "string")
    for (const run of packet.runs)
      for (const failure of run?.failures ?? [])
        if (size() > limit && failure?.file === packet.test.path) {
          delete failure.file;
          packet.omitted = true;
        }
  if (
    size() > limit &&
    packet.claim?.evidenceId &&
    Array.isArray(packet.runs) &&
    packet.runs.some((run) => run?.evidenceId === packet.claim.evidenceId)
  ) {
    delete packet.claim.evidenceId;
    packet.omitted = true;
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
