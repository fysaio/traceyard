/**
 * Retry policy maths.
 *
 * The execution engine hands these values to Cloudflare Workflows unchanged
 * (`retries.limit`, `retries.delay`, `retries.backoff`), and the API exposes the
 * same policy so the inspector shows the schedule that is actually in effect.
 *
 * Workflows applies:
 *   constant     -> delay, delay, delay, ...
 *   linear       -> delay * 1, delay * 2, delay * 3, ...
 *   exponential  -> delay * 1, delay * 2, delay * 4, ...
 *
 * There is deliberately no `maxDelayMs` field. Workflows has no cap parameter,
 * so a stored cap could not be enforced and would be a false guarantee.
 */

export type BackoffStrategy = "fixed" | "linear" | "exponential";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  backoff: BackoffStrategy;
}

/**
 * Delay before the next attempt after `failedAttempt` (1-based).
 *
 * `failedAttempt = 1` means the first attempt failed, so the value is the wait
 * before attempt 2.
 */
export function retryDelayMs(policy: RetryPolicy, failedAttempt: number): number {
  if (failedAttempt < 1) {
    throw new RangeError("failedAttempt must be >= 1");
  }
  const multiplier =
    policy.backoff === "exponential"
      ? 2 ** (failedAttempt - 1)
      : policy.backoff === "linear"
        ? failedAttempt
        : 1;
  return policy.baseDelayMs * multiplier;
}

/**
 * Cloudflare Workflows expresses retries as "retries after the first attempt".
 */
export function workflowRetryLimit(policy: RetryPolicy): number {
  return Math.max(0, policy.maxAttempts - 1);
}
