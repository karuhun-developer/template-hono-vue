import { hostname } from 'node:os'

import type { Logger } from 'pino'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

import { db as defaultDb, type Database } from '#db/client'
import { env } from '#env'
import { logger as defaultLogger } from '#lib/logger'
import type { QueueDriver, QueuedJob } from '#queue/queue'
import {
  claimJobs,
  insertJob,
  markFailed,
  markSucceeded,
  reapStaleJobs,
  type ClaimedJob,
} from '#queue/queue.repo'
import { JOBS, type JobCatalog } from '#queue/registry'

/**
 * The default driver: Postgres is the queue.
 *
 * The deciding property is that `push` can join the caller's transaction. The row that
 * changed and the job that acts on it commit together or not at all — a real outbox, with
 * no second system to keep in step. That is worth more to a template than throughput.
 *
 * The loop is claim → run → record, polling every `QUEUE_POLL_MS` and going straight round
 * again while there is still work. All the concurrency lives in one statement; see
 * `claimJobs` in `queue.repo.ts`.
 */

export type DatabaseQueueOptions = {
  /** Constructed directly by the driver suite, because `env` is frozen at boot. */
  database?: Database
  catalog?: JobCatalog
  logger?: Logger
  concurrency?: number
  pollMs?: number
  staleAfterMs?: number
  /** Written to `locked_by`. Defaults to `<hostname>:<pid>:<uuid>`. */
  workerId?: string
}

export type DatabaseQueue = QueueDriver & {
  /** Claim and run one batch, then resolve with how many ran. Drives the loop in tests. */
  tick: () => Promise<number>
  /** Hand back the rows a dead worker was holding. Scheduled as `queue.reap`. */
  reap: () => Promise<number>
}

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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createDatabaseQueue(options: DatabaseQueueOptions = {}): DatabaseQueue {
  const catalog: JobCatalog = options.catalog ?? JOBS

  const {
    database = defaultDb,
    logger = defaultLogger,
    concurrency = env.QUEUE_CONCURRENCY,
    pollMs = env.QUEUE_POLL_MS,
    staleAfterMs = env.QUEUE_STALE_AFTER_MINUTES * 60_000,
    workerId = `${hostname()}:${process.pid}:${uuidv7()}`,
  } = options

  const controller = new AbortController()

  let running = false
  let timer: NodeJS.Timeout | null = null
  let batch: Promise<number> | null = null

  const runJob = async (row: ClaimedJob): Promise<void> => {
    const child = logger.child({ job: row.name, jobId: row.id, attempt: row.attempts })
    const definition = catalog[row.name]

    if (!definition) {
      // Terminal, with no retry. A handler that is not registered will not be registered
      // on the second attempt either, and three tries would turn one confusing log line
      // into three.
      child.error('the job has no handler in this build')
      await markFailed(database, row.id, {
        error: `no handler is registered for the job "${row.name}"`,
        retryAt: null,
      })
      return
    }

    // Validated again here, not only on enqueue: this row may be older than the code
    // reading it. Terminal for the same reason — a retry re-reads the same bytes.
    const parsed = definition.payload.safeParse(row.payload)
    if (!parsed.success) {
      child.error({ issues: parsed.error.issues }, 'the stored payload no longer parses')
      await markFailed(database, row.id, {
        error: `the stored payload no longer matches the schema: ${z.prettifyError(parsed.error)}`,
        retryAt: null,
      })
      return
    }

    try {
      await definition.handler(parsed.data as never, {
        name: row.name,
        jobId: row.id,
        attempt: row.attempts,
        logger: child,
        signal: controller.signal,
      })
      await markSucceeded(database, row.id)
      child.debug('job succeeded')
    } catch (err) {
      const exhausted = row.attempts >= row.maxAttempts
      const retryAt = exhausted ? null : new Date(Date.now() + retryDelayMs(row.attempts))

      await markFailed(database, row.id, { error: describe(err), retryAt })

      if (exhausted) child.error({ err }, 'job failed for the last time')
      else child.warn({ err, retryAt }, 'job failed, retrying later')
    }
  }

  const tick = async (): Promise<number> => {
    const claimed = await claimJobs(database, { limit: concurrency, workerId })
    if (claimed.length === 0) return 0

    // A batch at a time rather than a rolling window of `concurrency`: the accounting
    // stays visible, and `stop()` has exactly one promise to wait on.
    await Promise.all(claimed.map((row) => runJob(row)))
    return claimed.length
  }

  /**
   * A self-rescheduling `setTimeout` rather than `setInterval(async …)`.
   *
   * Two reasons, and neither is style. An `async` callback handed to `setInterval` returns
   * a promise nothing awaits, so a slow tick overlaps the next one — and both
   * `no-misused-promises` and `no-floating-promises` say so. Rescheduling from the
   * settlement of the previous tick makes overlap impossible by construction.
   *
   * `.unref()` because an idle poll timer must not be the reason a process refuses to
   * exit; whatever wants the worker alive says so itself, in `src/worker.ts`.
   */
  const schedule = (delayMs: number): void => {
    if (!running) return

    timer = setTimeout(() => {
      timer = null
      const current = tick()
      batch = current

      void current.then(
        (count) => {
          batch = null
          // Straight round again while there is still work: a full batch means the table
          // very likely has more, and waiting a poll interval to find out is latency for
          // nothing.
          schedule(count > 0 ? 0 : pollMs)
        },
        (err: unknown) => {
          batch = null
          logger.error({ err }, 'queue tick failed')
          schedule(pollMs)
        },
      )
    }, delayMs)

    timer.unref()
  }

  return {
    kind: 'database',
    transactional: true,

    push: async (job: QueuedJob, tx) => {
      const accepted = await insertJob(tx ?? database, job)
      if (!accepted) {
        logger.debug({ job: job.name, dedupeKey: job.dedupeKey }, 'job already queued, skipped')
      }
    },

    start: () => {
      if (running) return
      running = true
      logger.info({ workerId, concurrency, pollMs }, 'queue polling started')
      schedule(0)
    },

    stop: async () => {
      running = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      // Wait for the batch already in flight. `runJob` records its own outcome and never
      // rejects, so the only failure that can reach here is a claim that could not run.
      if (batch !== null) {
        await batch.catch((err: unknown) => {
          logger.error({ err }, 'queue tick failed during shutdown')
        })
      }
      controller.abort()
    },

    tick,
    reap: () => reapStaleJobs(database, { olderThanMs: staleAfterMs }),
  }
}
