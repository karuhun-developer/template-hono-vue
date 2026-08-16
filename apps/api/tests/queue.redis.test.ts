import { eq, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { db } from '#db/client'
import { jobs, type Job } from '#db/schema'
import { createRedisQueue, type RedisQueue } from '#queue/driver/redis'
import { prepareJob } from '#queue/queue'
import type { JobCatalog, JobContext } from '#queue/registry'

/**
 * The redis driver, against a real Redis.
 *
 * **This suite does not skip when Redis is absent — it fails.** A suite that skips when its
 * dependency is missing is a suite that quietly stopped testing the feature, and the day
 * that matters is the day somebody has switched `QUEUE_DRIVER` in production. `make
 * up-redis` locally, a service container in CI, both on 7379.
 *
 * Each queue gets its own Redis key prefix, which is this suite's version of the `test.`
 * tag the database suite deletes by: one test cannot see another's jobs, and nothing here
 * touches a queue somebody is running on the same server.
 */

const TAG = 'test.'

const ran: string[] = []

const okPayload = z.object({ note: z.string() })

function okHandler(payload: z.infer<typeof okPayload>): Promise<void> {
  ran.push(payload.note)
  return Promise.resolve()
}

function throwingHandler(): Promise<void> {
  throw new Error('the handler said no')
}

async function slowHandler(_payload: unknown, ctx: JobContext): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40))
  ran.push(ctx.jobId)
}

const CATALOG: JobCatalog = {
  'test.ok': { payload: okPayload, handler: okHandler },
  'test.throws': { payload: z.object({}), handler: throwingHandler },
  'test.slow': { payload: z.object({}), handler: slowHandler },
}

/** Everything a test opened, so `afterEach` can close and empty it. */
const open: RedisQueue[] = []

let namespace = 0

function queueFor(overrides: { concurrency?: number } = {}): RedisQueue {
  namespace += 1
  const queue = createRedisQueue({
    catalog: CATALOG,
    prefix: `test-${process.pid}-${namespace}`,
    ...overrides,
  })
  open.push(queue)
  return queue
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Wait for a condition rather than for a duration — BullMQ's latency is not ours to guess. */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 20) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error(`the condition was still false after ${timeoutMs}ms`)
}

/** The same wait, for the row the driver mirrors into Postgres when a job dies. */
async function mirrored(name: string, timeoutMs = 10_000): Promise<Job> {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    const [row] = await db.select().from(jobs).where(eq(jobs.name, name))
    if (row) return row
    await sleep(50)
  }
  throw new Error(`nothing was mirrored into jobs for "${name}" within ${timeoutMs}ms`)
}

function cleanJobs(): Promise<unknown> {
  return db.delete(jobs).where(like(jobs.name, `${TAG}%`))
}

beforeAll(cleanJobs)

afterEach(async () => {
  ran.length = 0
  // Obliterate first, with a worker possibly still holding a lock — that is what `force`
  // is for. Stopping first would close the connection this needs.
  for (const queue of open.splice(0)) {
    await queue.obliterate()
    await queue.stop()
  }
  await cleanJobs()
})

afterAll(cleanJobs)

describe('the redis driver', () => {
  it('runs a job it was given', async () => {
    const queue = queueFor()
    queue.start()

    await queue.push(prepareJob('test.ok', { note: 'ran' }, {}, CATALOG))
    await until(() => ran.length > 0)

    expect(ran).toEqual(['ran'])
  })

  /**
   * The point of the mirror. BullMQ's own failure records live in Redis, expire with
   * `removeOnFail` and go with the server — so without this the Jobs page would show a
   * different history depending on which driver carried the job.
   */
  it('mirrors a job that failed for the last time into the jobs table', async () => {
    const queue = queueFor()
    queue.start()

    await queue.push(prepareJob('test.throws', {}, { maxAttempts: 2 }, CATALOG))

    const row = await mirrored('test.throws')

    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(2)
    expect(row.lastError).toContain('the handler said no')
    // Null on purpose: a historical row holding the unique key would reject the next
    // enqueue that reuses it.
    expect(row.dedupeKey).toBeNull()
  })

  it('writes nothing for a job that succeeded, which is the cost it exists to avoid', async () => {
    const queue = queueFor()
    queue.start()

    await queue.push(prepareJob('test.ok', { note: 'quiet' }, {}, CATALOG))
    await until(() => ran.length > 0)
    await sleep(150)

    const rows = await db
      .select()
      .from(jobs)
      .where(like(jobs.name, `${TAG}%`))
    expect(rows).toHaveLength(0)
  })

  it('fails a job whose handler this build does not have, without spending five attempts', async () => {
    const queue = queueFor()
    queue.start()

    // Straight past `prepareJob`, which would reject the name. This is a job enqueued by a
    // build that had the handler and picked up by one that no longer does.
    await queue.push({
      name: 'test.gone',
      payload: {},
      runAt: new Date(),
      maxAttempts: 5,
      dedupeKey: null,
    })

    const row = await mirrored('test.gone')

    expect(row.attempts).toBe(1)
    expect(row.lastError).toContain('no handler is registered')
  })

  /**
   * BullMQ builds its Redis keys by joining on `:` and therefore refuses a custom job id
   * containing one — and every dedupe key the scheduler produces is `<key>:<fired_for>`.
   */
  it('deduplicates on a key full of colons, which BullMQ will not take as an id', async () => {
    const queue = queueFor()
    const key = 'test.ok:2026-08-16T03:15:00.000Z'

    await queue.push(prepareJob('test.ok', { note: 'first' }, { dedupeKey: key }, CATALOG))
    await queue.push(prepareJob('test.ok', { note: 'second' }, { dedupeKey: key }, CATALOG))

    queue.start()
    await until(() => ran.length > 0)
    await sleep(200)

    expect(ran).toEqual(['first'])
  })

  it('runs several jobs at once without running one of them twice', async () => {
    const queue = queueFor({ concurrency: 4 })
    queue.start()

    for (let i = 0; i < 4; i += 1) {
      await queue.push(prepareJob('test.slow', {}, {}, CATALOG))
    }

    await until(() => ran.length === 4)

    expect(new Set(ran).size).toBe(4)
  })

  it('claims nothing once stopped', async () => {
    const queue = queueFor()
    queue.start()

    await queue.push(prepareJob('test.ok', { note: 'before' }, {}, CATALOG))
    await until(() => ran.length > 0)

    await queue.stop()

    await queue.push(prepareJob('test.ok', { note: 'after the stop' }, {}, CATALOG))
    await sleep(300)

    expect(ran).toEqual(['before'])
  })

  /** The property that makes `database` the default, asserted rather than assumed. */
  it('is not transactional, so an enqueue is never tied to a commit', () => {
    expect(queueFor().transactional).toBe(false)
  })

  /**
   * The readiness check, on the one driver that has anything of its own to check. It opens
   * the connection itself — an instance that has never enqueued anything is exactly the one
   * `GET /health/ready` is being asked about.
   */
  it('answers a health check without having been started or pushed to', async () => {
    await expect(queueFor().ping()).resolves.toBe(true)
  })

  it('answers false rather than hanging when there is no server on the port', async () => {
    // Port 1 is reserved and nothing listens on it. Bounded by `PING_TIMEOUT_MS`, which is
    // the whole point: a probe an orchestrator is timing must not wait for ioredis to
    // exhaust its retries.
    const unreachable = createRedisQueue({ catalog: CATALOG, url: 'redis://127.0.0.1:1' })

    await expect(unreachable.ping()).resolves.toBe(false)

    // Not through `open`: that teardown obliterates the queue first, which is a command to
    // a server that is not there. Closing is bounded here for the same reason the ping is.
    await Promise.race([unreachable.stop(), sleep(500)])
  }, 10_000)
})
