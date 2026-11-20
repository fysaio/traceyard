/**
 * Shorten a failure message for people and agents: drop stack frames inside
 * node_modules and Node internals, keep the first frame in the project, and
 * make throwaway checkout paths repository-relative.
 */
export function compactFailure(message) {
  const lines = message
    .replace(/(?:file:\/\/)?[^\s'"()]*traceyard-worktree-[^/\\]+[/\\]checkout[/\\]/g, "")
    .split("\n");
  const kept = [];
  let frames = 0;
  for (const line of lines) {
    if (/^\s+at\s/.test(line)) {
      if (/node_modules|node:internal|<anonymous>|\(native\)/.test(line) || frames >= 1) continue;
      frames++;
    }
    kept.push(line.trimEnd());
  }
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return kept.join("\n");
}
