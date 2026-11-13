/**
 * Retry policy maths. The execution engine hands these values to Cloudflare
 * Workflows, and the API exposes the same policy so the inspector shows the
 * schedule that is actually in effect.
 */

export type BackoffStrategy = "fixed" | "linear" | "exponential";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  backoff: BackoffStrategy;
  maxDelayMs: number;
}

export function retryDelayMs(policy: RetryPolicy, failedAttempt: number): number {
  if (failedAttempt < 1) {
    throw new RangeError("failedAttempt must be >= 1");
  }
  const exponent =
    policy.backoff === "exponential"
      ? Math.max(0, failedAttempt - 1)
      : policy.backoff === "linear"
        ? Math.max(0, failedAttempt - 1)
        : 0;
  const multiplier = policy.backoff === "fixed" ? 1 : Math.pow(2, exponent);
  return Math.min(policy.baseDelayMs * multiplier, policy.maxDelayMs);
}

/**
 * Cloudflare Workflows expresses retries as "retries after the first attempt".
 */
export function workflowRetryLimit(policy: RetryPolicy): number {
  return Math.max(0, policy.maxAttempts - 1);
}
