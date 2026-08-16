import type { Logger } from 'pino'
import { v7 as uuidv7 } from 'uuid'

import { logger as defaultLogger } from '#lib/logger'
import type { QueueDriver, QueuedJob } from '#queue/queue'
import { JOBS, type JobCatalog } from '#queue/registry'

/**
 * The driver that is not a queue: the handler runs inline, awaited, in the caller's
 * process, and **it rethrows**.
 *
 * Rethrowing is the entire point. This is what the test suite runs on, and a test that
 * asserts an invitation was created must fail when the email job behind it throws — a
 * queue that swallows the error there would make every suite pass while production burned.
 * The same reasoning says an endpoint test should assert the *effect* of a job rather than
 * the existence of a row.
 *
 * It writes no `jobs` row, so there is nothing to list, nothing to retry and nothing to
 * reap. The Jobs page says so rather than rendering an empty table that looks broken.
 *
 * It is also **not transactional**: running a handler inside the caller's transaction would
 * let it read rows nobody else can see yet, and let a rollback undo work that has already
 * left the process. `enqueue` therefore routes it through `defer`, so it runs after commit.
 */

export type SyncQueueOptions = {
  catalog?: JobCatalog
  logger?: Logger
}

export function createSyncQueue(options: SyncQueueOptions = {}): QueueDriver {
  const catalog: JobCatalog = options.catalog ?? JOBS
  const logger = options.logger ?? defaultLogger

  // One controller for the driver's life. Nothing aborts it — there is no loop to stop —
  // but a handler is entitled to a signal whichever driver is carrying it.
  const controller = new AbortController()

  const push = async (job: QueuedJob): Promise<void> => {
    const definition = catalog[job.name]
    if (!definition) {
      throw new Error(`no handler is registered for the job "${job.name}"`)
    }

    const jobId = uuidv7()
    const child = logger.child({ job: job.name, jobId, driver: 'sync' })

    // Parsed again rather than trusted, so the sync driver puts a handler through exactly
    // the same door the database driver does.
    const payload = definition.payload.parse(job.payload) as never

    child.debug('running job inline')
    await definition.handler(payload, {
      name: job.name,
      jobId,
      attempt: 1,
      // One, not the job's setting: this driver rethrows and never comes back.
      maxAttempts: 1,
      logger: child,
      signal: controller.signal,
    })
  }

  return {
    kind: 'sync',
    transactional: false,
    push,
    start: () => {},
    stop: () => Promise.resolve(),
  }
}
