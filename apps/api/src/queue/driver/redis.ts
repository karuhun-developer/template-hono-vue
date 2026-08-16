import { hostname } from 'node:os'

import type { Job as BullJob, Queue as BullQueue, Worker as BullWorker } from 'bullmq'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

import { db as defaultDb, type Database } from '#db/client'
import { env } from '#env'
import { logger as defaultLogger } from '#lib/logger'
import { describeError, expire, retryDelayMs } from '#queue/driver/shared'
import type { QueueDriver, QueuedJob } from '#queue/queue'
import { recordFailedJob } from '#queue/queue.repo'
import { JOBS, type JobCatalog } from '#queue/registry'

/**
 * The driver for when Postgres is not where the queue should live.
 *
 * BullMQ rather than a hand-rolled Redis list: delayed jobs, backoff, concurrency limits
 * and stalled-job recovery are all things a first implementation gets subtly wrong, and
 * the subtle part only shows up under the load that made someone reach for Redis.
 *
 * **`bullmq` and `ioredis` are loaded through `await import()`**, never at module scope.
 * `queue.ts` constructs a driver synchronously at boot from `QUEUE_DRIVER`, and a Postgres
 * deployment — the default — must never pay to parse a Redis client it will not use. The
 * cost is that everything here is lazy: the first `push` is what opens the connection.
 *
 * What this driver **cannot** do is join the caller's transaction, and that is the whole
 * reason `database` is the default. `transactional` is `false`, so `dispatch()` routes an
 * enqueue through `defer` and it happens after commit. The remaining hole — a crash in the
 * moment between the commit and the dispatch — is closed for mail by the `mail_messages`
 * outbox row and the `mail.sweep-stuck` schedule, not by this file.
 */

export type RedisQueueOptions = {
  /** Defaults to `REDIS_URL`. Constructed directly by the driver suite, because `env` is frozen. */
  url?: string
  catalog?: JobCatalog
  logger?: Logger
  /** Where terminal failures are mirrored, so one Jobs page works for every driver. */
  database?: Database
  concurrency?: number
  /**
   * The BullMQ queue name, and the Redis key prefix in front of it.
   *
   * Two installations sharing one Redis must not read each other's jobs, and neither must
   * two test files. There is no environment variable for either: an installation that
   * shares a Redis is already editing a compose file, and one that does not gains a knob
   * with one correct value.
   */
  queueName?: string
  prefix?: string
}

export type RedisQueue = QueueDriver & {
  /** Resolve once the queue is connected. Tests need to know; nothing in production does. */
  ready: () => Promise<void>
  /** Delete every key this queue owns. Test teardown only. */
  obliterate: () => Promise<void>
}

/**
 * BullMQ rejects a custom job id containing `:` — it builds its Redis keys by joining on
 * that character, so an id carrying one would address a key belonging to something else.
 * Our dedupe keys are `<schedule>:<fired_for>`, which is nothing but colons.
 *
 * Percent-escaping rather than replacing, and `%` first: `a:b` and `a%3Ab` are different
 * keys, and a substitution that mapped them onto the same id would drop a real job as a
 * duplicate roughly never, which is the worst frequency for a bug to have.
 */
function toJobId(dedupeKey: string): string {
  return dedupeKey.replaceAll('%', '%25').replaceAll(':', '%3A')
}

/**
 * Call `load` at most once and hand everyone the same promise.
 *
 * Written as a generic rather than as a `let module: Promise<typeof import('bullmq')>`,
 * because a hand-written `import()` **type** is what `consistent-type-imports` forbids —
 * and rightly, since it is the one form that reads as a runtime import but is not one.
 * Inference gets there on its own.
 */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  return () => (pending ??= load())
}

export function createRedisQueue(options: RedisQueueOptions = {}): RedisQueue {
  const catalog: JobCatalog = options.catalog ?? JOBS

  const {
    logger = defaultLogger,
    database = defaultDb,
    concurrency = env.QUEUE_CONCURRENCY,
    queueName = 'jobs',
    prefix = 'bull',
  } = options

  const url = options.url ?? env.REDIS_URL
  if (!url) {
    // Unreachable through `queue.ts` — `env.ts` refuses to boot with QUEUE_DRIVER=redis and
    // no REDIS_URL. Reachable by a test constructing the factory directly, which is exactly
    // who benefits from being told which setting is missing.
    throw new Error('REDIS_URL is required by the redis queue driver')
  }

  const workerId = `${hostname()}:${process.pid}:${uuidv7()}`
  const controller = new AbortController()
  const connections: Redis[] = []

  let queuePromise: Promise<BullQueue> | null = null
  let workerPromise: Promise<BullWorker> | null = null

  const loadBullmq = once(() => import('bullmq'))

  const connect = async (role: 'queue' | 'worker'): Promise<Redis> => {
    const { default: RedisClient } = await import('ioredis')

    const client = new RedisClient(url, {
      /**
       * **The BullMQ gotcha.** A worker blocks on `BZPOPMIN` for seconds at a time, and
       * ioredis counts a blocked command as a request that has not answered — at the
       * default of twenty retries it gives up and throws. BullMQ knows this and refuses to
       * start a `Worker` on a connection without `null` here, but the error it throws names
       * neither this option nor ioredis, so the search that follows is a long one.
       *
       * Only the worker needs it. The queue's connection issues ordinary commands, and
       * bounded retries there are the behaviour you want.
       */
      maxRetriesPerRequest: role === 'worker' ? null : 20,
    })

    client.on('error', (err: unknown) => {
      // ioredis reconnects on its own; an unhandled 'error' event would take the process
      // down instead, which is a strange way to survive a Redis restart.
      logger.error({ err, role }, 'redis connection error')
    })

    connections.push(client)
    return client
  }

  const getQueue = (): Promise<BullQueue> => {
    queuePromise ??= (async () => {
      const [{ Queue }, connection] = await Promise.all([loadBullmq(), connect('queue')])

      return new Queue(queueName, {
        connection,
        prefix,
        defaultJobOptions: {
          // Redis is memory. A finished job kept forever is a leak with a slow fuse, so
          // successes are dropped quickly and failures are kept long enough to be read —
          // and the terminal ones are in Postgres anyway, via `recordFailedJob`.
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86_400 },
        },
      })
    })()

    return queuePromise
  }

  /**
   * One attempt, from BullMQ's side.
   *
   * `attemptsMade` counts the attempts *finished*, so the run about to happen is the next
   * one. Everything else mirrors the database driver deliberately: same two terminal cases,
   * same validation on the way out of the queue, same shape of log line.
   */
  const runJob = async (job: BullJob<Record<string, unknown>>): Promise<void> => {
    const attempt = job.attemptsMade + 1
    const maxAttempts = job.opts.attempts ?? env.QUEUE_MAX_ATTEMPTS
    const jobId = String(job.id)
    const child = logger.child({ job: job.name, jobId, attempt, driver: 'redis' })

    const record = (error: string): Promise<void> =>
      recordFailedJob(database, {
        name: job.name,
        payload: job.data,
        attempts: attempt,
        maxAttempts,
        error,
        lockedBy: workerId,
      })

    /**
     * A failure no retry can fix: an unregistered name, or a payload that no longer parses.
     * Neither improves on the second attempt, and three tries would turn one confusing log
     * line into three, so `UnrecoverableError` tells BullMQ to stop now.
     *
     * Returned rather than thrown so the call site can `throw await terminal(…)` — which
     * is what makes the code after it unreachable to the type checker too.
     */
    const terminal = async (error: string): Promise<Error> => {
      await record(error)
      const { UnrecoverableError } = await loadBullmq()
      return new UnrecoverableError(error)
    }

    const definition = catalog[job.name]
    if (!definition) {
      child.error('the job has no handler in this build')
      throw await terminal(`no handler is registered for the job "${job.name}"`)
    }

    const parsed = definition.payload.safeParse(job.data)
    if (!parsed.success) {
      child.error({ issues: parsed.error.issues }, 'the stored payload no longer parses')
      throw await terminal(
        `the stored payload no longer matches the schema: ${z.prettifyError(parsed.error)}`,
      )
    }

    try {
      await definition.handler(parsed.data as never, {
        name: job.name,
        jobId,
        attempt,
        maxAttempts,
        logger: child,
        signal: controller.signal,
      })
      child.debug('job succeeded')
    } catch (err) {
      const error = describeError(err)

      if (attempt >= maxAttempts) {
        child.error({ err }, 'job failed for the last time')
        await record(error)
      } else {
        child.warn({ err }, 'job failed, retrying later')
      }

      // Rethrown either way: BullMQ owns the retry, the backoff and the stalled-job
      // accounting. Swallowing it here would mark the job complete.
      throw err
    }
  }

  const startWorker = async (): Promise<BullWorker> => {
    const [{ Worker }, connection] = await Promise.all([loadBullmq(), connect('worker')])

    const worker = new Worker<Record<string, unknown>>(queueName, runJob, {
      connection,
      prefix,
      concurrency,
      settings: {
        // One retry policy for both drivers. Without this BullMQ would back off on its own
        // curve with no jitter, so `QUEUE_DRIVER` would change how often a flapping
        // dependency gets hit — a change in behaviour dressed up as a change in transport.
        backoffStrategy: (attemptsMade: number) => retryDelayMs(attemptsMade),
      },
    })

    worker.on('error', (err: unknown) => {
      logger.error({ err }, 'redis queue worker error')
    })

    logger.info({ workerId, queueName, concurrency }, 'redis queue worker started')
    return worker
  }

  return {
    kind: 'redis',
    // The line that routes every enqueue through `defer`. See the note at the top.
    transactional: false,

    push: async (job: QueuedJob, tx) => {
      if (tx) {
        logger.debug(
          { job: job.name },
          'the redis driver cannot join a Postgres transaction — this enqueue is independent of it',
        )
      }

      const queue = await getQueue()
      const jobId = job.dedupeKey === null ? undefined : toJobId(job.dedupeKey)

      if (jobId !== undefined && (await queue.getJob(jobId)) !== undefined) {
        // Redis enforces the deduplication either way — `add` with an id that already
        // exists returns the existing job rather than a second one. This lookup only buys
        // the log line, so losing the race with a concurrent enqueue costs nothing.
        logger.debug({ job: job.name, dedupeKey: job.dedupeKey }, 'job already queued, skipped')
        return
      }

      await queue.add(job.name, job.payload, {
        // Spread rather than `jobId`: `exactOptionalPropertyTypes` is on, and BullMQ's
        // option is "absent or a string", not "a string or undefined".
        ...(jobId === undefined ? {} : { jobId }),
        delay: Math.max(0, job.runAt.getTime() - Date.now()),
        attempts: job.maxAttempts,
        backoff: { type: 'custom' },
      })
    },

    start: () => {
      if (workerPromise) return

      const pending = startWorker()
      workerPromise = pending

      // `start()` is synchronous by contract — the database driver has nothing to await.
      // The failure still has to go somewhere, and `stop()` may never be called.
      void pending.catch((err: unknown) => {
        logger.error({ err }, 'the redis queue worker failed to start')
      })
    },

    stop: async (stopOptions = {}) => {
      const pending = workerPromise
      workerPromise = null

      if (pending) {
        try {
          const worker = await pending
          const graceMs = stopOptions.graceMs ?? env.QUEUE_SHUTDOWN_GRACE_MS

          // `close()` stops taking new jobs and waits for the ones in flight; `close(true)`
          // does not wait. The rows left behind are BullMQ's stalled jobs, and it hands
          // them to another worker on its own.
          const finished = await Promise.race([worker.close().then(() => true), expire(graceMs)])
          if (!finished) {
            logger.warn({ graceMs }, 'jobs were still running when the grace period ran out')
            await worker.close(true)
          }
        } catch (err) {
          logger.error({ err }, 'the redis queue worker did not stop cleanly')
        }
      }

      const openQueue = queuePromise
      queuePromise = null
      if (openQueue) {
        await openQueue.then(
          (queue) => queue.close(),
          () => {},
        )
      }

      await Promise.all(
        connections.splice(0).map((client) =>
          client.quit().catch(() => {
            client.disconnect()
          }),
        ),
      )

      controller.abort()
    },

    ready: async () => {
      await (await getQueue()).waitUntilReady()
    },

    obliterate: async () => {
      await (await getQueue()).obliterate({ force: true })
    },
  }
}
