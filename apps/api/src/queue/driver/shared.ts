/**
 * The few things every driver needs, in one place.
 *
 * The retry policy in particular: a job that gives up after three tries on Postgres and
 * after thirty seconds of tight retries on Redis would make `QUEUE_DRIVER` a change in
 * behaviour rather than a change in transport. Both drivers back off through
 * `retryDelayMs` — the database driver computes `run_at` with it, the redis driver hands
 * it to BullMQ as a custom backoff strategy.
 */

/**
 * `min(1000 * 2^(attempt-1), 300_000)`, plus or minus a fifth.
 *
 * The jitter is not cosmetic: a hundred jobs failing together because one dependency was
 * down would otherwise all come back at the same instant, and take it down again.
 */
export function retryDelayMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 300_000)
  return Math.round(base * (1 + 0.2 * (Math.random() * 2 - 1)))
}

/** Whatever was thrown, as a line fit for `last_error`. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Resolves `false` after `ms`. Unreffed, so waiting for a grace period never delays an exit. */
export function expire(ms: number): Promise<false> {
  return new Promise<false>((resolve) => {
    setTimeout(() => resolve(false), ms).unref()
  })
}
