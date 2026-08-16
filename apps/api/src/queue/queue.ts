import { z } from 'zod'

import type { Transaction } from '#db/client'
import type { Defer } from '#db/tx'
import { env } from '#env'
import { onShutdown } from '#lib/shutdown'
import { createDatabaseQueue } from '#queue/driver/database'
import { createRedisQueue } from '#queue/driver/redis'
import { createSyncQueue } from '#queue/driver/sync'
import { JOBS, type JobCatalog, type JobName, type JobPayload } from '#queue/registry'

/**
 * The queue, from the caller's side.
 *
 * `enqueue('sessions.prune', {})` is the whole API. Which driver carries it, whether it
 * runs in this process or another one, and how many times it is retried are configuration
 * — see `docs/features/queue.md` for the guarantee each driver gives.
 *
 * The one thing a caller does have to decide is **when** the job becomes real, and that is
 * what `tx` and `defer` are for. Both come from `transaction(async (tx, defer) => …)`:
 *
 * ```ts
 * await transaction(async (tx, defer) => {
 *   const user = await createUser(tx, input)
 *   await enqueue('mail.send', { userId: user.id }, { tx, defer })
 * })
 * ```
 *
 * A transactional driver inserts through `tx`, so the change and its consequence commit
 * together. A driver that cannot join a Postgres transaction goes through `defer`, so at
 * worst the job is lost — never dispatched for a row that then rolled back, which is the
 * failure that produces an email about an account that does not exist.
 */

export type QueueKind = 'sync' | 'database' | 'redis'

/** A job that has been validated and is ready for a driver. Payload is plain JSON. */
export type QueuedJob = {
  readonly name: string
  readonly payload: Record<string, unknown>
  readonly runAt: Date
  readonly maxAttempts: number
  readonly dedupeKey: string | null
}

export type QueueDriver = {
  readonly kind: QueueKind
  /** True only when `push` can join the caller's Postgres transaction. */
  readonly transactional: boolean
  push: (job: QueuedJob, tx?: Transaction) => Promise<void>
  /** Begin claiming work. Called by the worker, never by the API. */
  start: () => void
  /**
   * Stop claiming and let what is in flight finish, for up to `graceMs`. Then the handlers
   * still running are told through `ctx.signal` that nobody is waiting any more.
   *
   * Safe to call when nothing was ever started.
   */
  stop: (options?: { graceMs?: number }) => Promise<void>
}

export type EnqueueOptions = {
  /** The caller's transaction. Honoured only by a transactional driver. */
  tx?: Transaction
  /** The caller's post-commit hook. Used by every driver that cannot honour `tx`. */
  defer?: Defer
  runAt?: Date
  delayMs?: number
  maxAttempts?: number
  /** At most one live job per key — the scheduler's protection against a double fire. */
  dedupeKey?: string
}

/**
 * Validate and normalise, before anything is written.
 *
 * Failing here means failing **inside the caller's transaction**, so a job with a payload
 * the handler could never have used takes the whole change down with it rather than
 * surfacing three retries later in a worker log nobody is reading.
 *
 * The payload goes through `JSON.parse(JSON.stringify(…))` once, here. What a handler is
 * given is then identical whichever driver carried it — a `Date` that survives the sync
 * driver and arrives as a string from the database driver is the worst kind of difference
 * between a test run and production.
 */
export function prepareJob(
  name: string,
  payload: unknown,
  options: EnqueueOptions = {},
  catalog: JobCatalog = JOBS,
): QueuedJob {
  const definition = catalog[name]
  if (!definition) {
    throw new Error(`unknown job "${name}" — add it to JOBS in src/queue/registry.ts`)
  }

  const parsed = definition.payload.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`the payload for "${name}" is invalid: ${z.prettifyError(parsed.error)}`)
  }

  return {
    name,
    payload: JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>,
    runAt: options.runAt ?? new Date(Date.now() + (options.delayMs ?? 0)),
    maxAttempts: options.maxAttempts ?? definition.maxAttempts ?? env.QUEUE_MAX_ATTEMPTS,
    dedupeKey: options.dedupeKey ?? null,
  }
}

/**
 * Hand a prepared job to a driver, at the right moment.
 *
 * Note the last branch: a `tx` given to a driver that cannot use it, with no `defer` to
 * fall back on, dispatches immediately — outside the transaction. `transaction()` always
 * supplies both, so the only way to reach that line is to pass `tx` by itself.
 */
export function dispatch(
  driver: QueueDriver,
  job: QueuedJob,
  options: Pick<EnqueueOptions, 'tx' | 'defer'> = {},
): Promise<void> {
  if (driver.transactional && options.tx) return driver.push(job, options.tx)

  if (options.defer) {
    options.defer(`queue:${job.name}`, () => driver.push(job))
    return Promise.resolve()
  }

  return driver.push(job)
}

function createQueueFromEnv(): QueueDriver {
  switch (env.QUEUE_DRIVER) {
    case 'sync':
      return createSyncQueue()
    case 'database':
      return createDatabaseQueue()
    case 'redis':
      return createRedisQueue()
  }
}

/**
 * The process-wide driver.
 *
 * Constructing it does not start anything — the API imports this module in order to
 * enqueue, and an API replica that quietly began claiming jobs would be a second worker
 * nobody asked for. `start()` is called from `src/worker.ts` and nowhere else.
 */
export const queue: QueueDriver = createQueueFromEnv()

/**
 * Registered here rather than in an entrypoint, so the ordering is right by construction:
 * this module imports the pool, so the pool registered first and therefore closes last —
 * after the jobs still draining through it.
 */
onShutdown('queue', () => queue.stop())

export function enqueue<N extends JobName>(
  name: N,
  payload: JobPayload<N>,
  options: EnqueueOptions = {},
): Promise<void> {
  return dispatch(queue, prepareJob(name, payload, options), options)
}
