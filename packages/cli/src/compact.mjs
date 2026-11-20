// Output shaping for people and agents. Everything an agent reads passes
// through here, so it stays small and free of terminal noise.

// CSI sequences (colours, cursor moves) and OSC sequences (hyperlinks, titles).
/* eslint-disable no-control-regex */
const ANSI =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/* eslint-enable no-control-regex */
const WORKTREE = /(?:file:\/\/)?[^\s'"()]*traceyard-worktree-[^/\\]+[/\\]checkout[/\\]/g;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Make paths repository-relative: throwaway checkouts and, when given, the clone itself. */
export function relativePaths(text, root) {
  let out = text.replace(WORKTREE, "");
  if (root) {
    const forward = root.split("\\").join("/");
    for (const prefix of new Set([root, forward]))
      out = out.replace(new RegExp(`(?:file:///?)?${escapeRegExp(prefix)}[/\\\\]`, "g"), "");
  }
  return out;
}

/**
 * Terminal output as plain text: no ANSI codes, carriage-return progress bars
 * collapsed to their final state, repeated lines and runs of blank lines
 * folded into one.
 */
export function cleanOutput(text, root) {
  const lines = relativePaths(String(text ?? "").replace(ANSI, ""), root)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.includes("\r") ? (line.split("\r").findLast((p) => p) ?? "") : line))
    .map((line) => line.trimEnd());
  const kept = [];
  let repeats = 0;
  for (const line of lines) {
    const previous = kept.at(-1);
    if (previous !== undefined && line === previous) {
      if (line) repeats++;
      continue;
    }
    if (repeats)
      kept.push(`  (previous line repeated ${repeats} more time${repeats > 1 ? "s" : ""})`);
    repeats = 0;
    kept.push(line);
  }
  if (repeats)
    kept.push(`  (previous line repeated ${repeats} more time${repeats > 1 ? "s" : ""})`);
  while (kept.length && !kept[0]) kept.shift();
  while (kept.length && !kept.at(-1)) kept.pop();
  return kept.join("\n");
}

/**
 * Shorten a failure message: clean it, drop stack frames inside node_modules
 * and Node internals, and keep only the first frame in the project.
 */
export function compactFailure(message, root) {
  const kept = [];
  let frames = 0;
  for (const line of cleanOutput(message, root).split("\n")) {
    if (/^\s+at\s/.test(line)) {
      if (/node_modules|node:internal|<anonymous>|\(native\)/.test(line) || frames >= 1) continue;
      frames++;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** Rough token count used for budgets and benchmarks: about four characters per token. */
export const estimateTokens = (text) => Math.ceil(String(text).length / 4);
