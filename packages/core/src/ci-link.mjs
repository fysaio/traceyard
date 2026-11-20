// Pure helpers for GitHub Actions links and job logs. Shared by the hosted
// service (worker/services/ci-revision.ts) and the local `traceyard` CLI.

const shaPattern = /^[a-f0-9]{40}$/i;

/**
 * Parse a GitHub Actions run, attempt or job link. Returns null for anything
 * else, including links with credentials or a non-GitHub origin.
 */
export function parseActionsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const match = url.pathname.match(
    /^\/([\w.-]+\/[\w.-]+)\/actions\/runs\/([1-9]\d{0,17})(?:\/attempts\/([1-9]\d{0,17}))?(?:\/job\/([1-9]\d{0,17}))?\/?$/,
  );
  if (url.origin !== "https://github.com" || url.username || url.password || !match?.[1])
    return null;
  return { repository: match[1], runId: match[2], attempt: match[3], jobId: match[4] };
}

const cleanLines = (log) =>
  log.split(/\r?\n/).map((line) =>
    line
      .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, "")
      // eslint-disable-next-line no-control-regex -- GitHub can colorize job logs.
      .replace(/\x1b\[[\d;]*m/g, "")
      .trim(),
  );

/**
 * Find the single commit that actions/checkout checked out for `repository`.
 * Returns null when there is no checkout or more than one, so callers never
 * guess between revisions.
 */
export function readCheckoutRevision(log, repository) {
  const lines = cleanLines(log);
  const checkouts = [];
  let observing = false,
    merge = false;
  for (const [index, line] of lines.entries()) {
    const checkout = line.match(/^(?:##\[group\])?Syncing repository: (\S+)$/i);
    if (checkout?.[1]) {
      observing = checkout[1].toLowerCase() === repository.toLowerCase();
      merge = false;
    }
    if (!observing) continue;
    if (/^\[command\].*\s(?:checkout|fetch)\s.*refs\/(?:remotes\/)?pull\/\d+\/merge\b/.test(line))
      merge = true;
    if (/^\[command\].*\bgit\s+log\s+-1\s+--format=%H$/.test(line)) {
      const commit = lines[index + 1];
      if (commit && shaPattern.test(commit))
        checkouts.push({ commit: commit.toLowerCase(), merge });
      observing = false;
    }
  }
  return checkouts.length === 1 ? checkouts[0] : null;
}

const testPathPattern = /^[A-Za-z0-9_./@-]+$/;

/**
 * Read failing test files from a Vitest, Jest or Pytest job log. Returns
 * repository-relative paths in first-seen order, without duplicates.
 */
export function failingTestsFromLog(log) {
  const found = [];
  const add = (path) => {
    const clean = path.replace(/^\.\//, "");
    if (testPathPattern.test(clean) && !clean.startsWith("..") && !found.includes(clean))
      found.push(clean);
  };
  for (const line of cleanLines(log)) {
    // Vitest: " FAIL  src/a.test.ts > suite > case", Jest: "FAIL src/a.test.ts (1.2 s)"
    const js = line.match(
      /^(?:[×✗❯]\s*)?FAIL\s+(?:\|[^|]+\|\s+)?(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b/,
    );
    if (js?.[1]) add(js[1]);
    // Pytest short summary: "FAILED tests/test_a.py::test_case - AssertionError"
    const py = line.match(/^FAILED\s+(\S+?\.py)::/);
    if (py?.[1]) add(py[1]);
  }
  return found;
}
