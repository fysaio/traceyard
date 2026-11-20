/** The command line was wrong. Exit code 64. */
export class UsageError extends Error {
  name = "UsageError";
}

/** The input was right but the test could not run here. Verdict BLOCKED, exit code 3. */
export class BlockedError extends Error {
  name = "BlockedError";
}
