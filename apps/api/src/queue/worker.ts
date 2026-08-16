import { env } from '#env'
import { logger } from '#lib/logger'
import { queue, type QueueDriver } from '#queue/queue'

/**
 * Starting and stopping the loop that claims jobs.
 *
 * Two entrypoints reach this: `src/worker.ts`, which exists to do nothing else, and
 * `src/index.ts` when `WORKER_IN_PROCESS` is on. Both have to make the same decisions — is
 * there anything for a worker to do, has one already been started — so those decisions live
 * here rather than being written twice and drifting apart.
 *
 * What is deliberately **not** here is the reason a process stays alive. The poll timer is
 * `.unref()`'d, so a dedicated worker needs a handle of its own; `src/worker.ts` owns that,
 * because the API must not grow one.
 */

let started: QueueDriver | null = null

export function startWorker(driver: QueueDriver = queue): boolean {
  if (started) return false

  if (driver.kind === 'sync') {
    // Not an error, and not silent either. `QUEUE_DRIVER=sync` runs every handler inside
    // the process that enqueued it, so a worker would poll a table nothing is written to.
    logger.warn(
      { driver: driver.kind },
      'the sync driver runs jobs inline — a worker has nothing to claim',
    )
    return false
  }

  started = driver
  driver.start()
  return true
}

export async function stopWorker(): Promise<void> {
  const driver = started
  if (!driver) return

  started = null
  await driver.stop({ graceMs: env.QUEUE_SHUTDOWN_GRACE_MS })
}

export function isWorkerRunning(): boolean {
  return started !== null
}
