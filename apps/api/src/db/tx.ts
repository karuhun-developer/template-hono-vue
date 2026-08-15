import { db, type Transaction } from '#db/client'
import { logger } from '#lib/logger'

/**
 * A transaction that can also schedule work for **after** the commit.
 *
 * Two failures this exists to prevent, both of which look fine in review:
 *
 * - An email sent inside `db.transaction` is an email sent for a row that may still roll
 *   back. The recipient gets an invitation to an account that does not exist.
 * - A cache entry invalidated inside the transaction is re-populated by any concurrent
 *   reader before the commit lands, so the stale value is what survives.
 *
 * Anything that writes goes through the `tx` handle, exactly as before. Anything that
 * reaches outside the database — sending, dispatching, invalidating — goes through
 * `defer`, and runs only if the transaction actually committed.
 *
 * Services with no side effects keep using `db.transaction` directly. This is the heavier
 * tool; reach for it when there is something to defer.
 */

export type DeferredTask = () => Promise<void> | void

export type Defer = (name: string, task: DeferredTask) => void

export async function transaction<T>(
  fn: (tx: Transaction, defer: Defer) => Promise<T> | T,
): Promise<T> {
  const deferred: { name: string; task: DeferredTask }[] = []
  let sealed = false

  const defer: Defer = (name, task) => {
    if (sealed) {
      // Deferring after the commit means the caller kept the handle past the callback,
      // which also means the `tx` they are holding is dead. Fail loudly rather than run
      // the task at some unrelated moment.
      throw new Error(`defer("${name}") was called after the transaction had already finished`)
    }
    deferred.push({ name, task })
  }

  const result = await db.transaction((tx) => Promise.resolve(fn(tx, defer)))
  sealed = true

  // Sequential, because order is part of the meaning: invalidate the cache, *then*
  // dispatch the job that will read through it.
  for (const { name, task } of deferred) {
    try {
      await task()
    } catch (err) {
      // Swallowed on purpose. The write has committed; there is nothing left to roll back,
      // and turning a successful change into a 500 would be a lie to the caller. The log
      // line is the record, and every deferred task is expected to be independently
      // recoverable — a queued email is swept, a cache entry expires.
      logger.error({ err, task: name }, 'deferred task failed after commit')
    }
  }

  return result
}
