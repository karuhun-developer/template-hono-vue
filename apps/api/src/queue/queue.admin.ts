import { db, type Database, type DatabaseHandle } from '#db/client'
import type { Job } from '#db/schema'
import { env } from '#env'
import { conflict } from '#lib/errors'
import {
  cancelJob,
  findJob,
  listJobs,
  requeueJob,
  type ListJobsFilter,
  type ListJobsPage,
} from '#queue/queue.repo'

/**
 * Administering jobs, as opposed to running them.
 *
 * Deliberately **not** part of `QueueDriver`. Running a job and answering "what happened
 * to it" have different shapes — one is a claim loop, the other is a paged list with
 * filters — and a driver that had to implement both would be two objects sharing a name.
 * Splitting them also lets the sync driver be honest: it runs handlers inline and stores
 * nothing, so there is genuinely nothing to administer, and saying so is better than an
 * empty table that looks broken.
 *
 * What each driver can offer, and why:
 *
 * | `QUEUE_DRIVER` | `coverage`  | `manageable` |
 * | -------------- | ----------- | ------------ |
 * | `database`     | `all`       | yes          |
 * | `redis`        | `failures`  | no           |
 * | `sync`         | `none`      | no           |
 *
 * Both flags travel in the list response, so the console can say which of the three it is
 * looking at rather than guessing from an empty page.
 */

/**
 * How much of what ran is in the `jobs` table under the configured driver.
 *
 * - `all` — the table *is* the queue. Every job is here, in every state.
 * - `failures` — BullMQ owns the live queue; what is here is the durable record of the
 *   jobs that died, mirrored so that one page works whatever carried them.
 * - `none` — jobs run inline in the caller's request and leave nothing behind.
 */
export type JobCoverage = 'all' | 'failures' | 'none'

export type QueueAdmin = {
  readonly coverage: JobCoverage
  /** Whether retry and cancel do anything. False means both answer `409`. */
  readonly manageable: boolean
  list: (filter: ListJobsFilter) => Promise<ListJobsPage>
  find: (handle: DatabaseHandle, id: string) => Promise<Job | null>
  /**
   * Both mutate through the caller's handle, so the change and its audit entry commit
   * together — the same rule every other write in this codebase follows.
   */
  retry: (handle: DatabaseHandle, job: Job) => Promise<Job>
  cancel: (handle: DatabaseHandle, job: Job) => Promise<Job>
}

const EMPTY: ListJobsPage = { rows: [], total: 0 }

/** The `jobs` table is the queue: everything is here, and everything can be changed. */
export function createDatabaseJobAdmin(options: { database?: Database } = {}): QueueAdmin {
  const database = options.database ?? db

  return {
    coverage: 'all',
    manageable: true,
    list: (filter) => listJobs(database, filter),
    find: findJob,
    retry: (handle, job) => requeueJob(handle, job.id),
    cancel: (handle, job) => cancelJob(handle, job.id),
  }
}

/**
 * Reading works; changing does not.
 *
 * A row here is a **copy** of something that already died inside BullMQ — see
 * `recordFailedJob`. Flipping that copy back to `pending` would change nothing in Redis,
 * where the queue actually is, and would leave a row claiming to be queued that no worker
 * will ever look at. Enqueueing a fresh job instead would be a different job with a
 * different id, which is not what a button labelled "Retry" says it does.
 *
 * So this admin refuses, and says why. Re-running the work is `enqueue()` from a call site
 * that knows what the payload means, and a BullMQ dashboard is the tool for the live queue.
 */
export function createRedisJobAdmin(options: { database?: Database } = {}): QueueAdmin {
  const database = options.database ?? db

  const refuse = (verb: string): never => {
    throw conflict(
      `A job cannot be ${verb} while QUEUE_DRIVER=redis. What is listed here is a record of jobs that failed, copied out of Redis so it outlives them — the queue itself lives in Redis.`,
    )
  }

  return {
    coverage: 'failures',
    manageable: false,
    list: (filter) => listJobs(database, filter),
    find: findJob,
    retry: () => refuse('run again'),
    cancel: () => refuse('cancelled'),
  }
}

/**
 * Nothing ran anywhere but here, and nothing was written down.
 *
 * An empty page rather than a 404 or an error: the endpoint works, the answer is genuinely
 * zero rows, and `coverage: 'none'` is what tells the console to explain that instead of
 * rendering an empty table beside a pager.
 */
export function createSyncJobAdmin(): QueueAdmin {
  const refuse = (): never => {
    throw conflict('Jobs run inline in this configuration, so there is nothing to retry or cancel.')
  }

  return {
    coverage: 'none',
    manageable: false,
    list: () => Promise.resolve(EMPTY),
    find: () => Promise.resolve(null),
    retry: refuse,
    cancel: refuse,
  }
}

function createAdminFromEnv(): QueueAdmin {
  switch (env.QUEUE_DRIVER) {
    case 'sync':
      return createSyncJobAdmin()
    case 'database':
      return createDatabaseJobAdmin()
    case 'redis':
      return createRedisJobAdmin()
  }
}

/**
 * The process-wide admin.
 *
 * A factory beside the singleton, for the reason every subsystem here has one: `env` is
 * parsed once and frozen at boot, so a suite that wants to exercise the database admin
 * cannot get there by flipping `QUEUE_DRIVER`.
 */
export const queueAdmin: QueueAdmin = createAdminFromEnv()
