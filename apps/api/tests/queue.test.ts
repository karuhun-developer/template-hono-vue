import { and, eq, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { db } from '#db/client'
import { jobs, type Job } from '#db/schema'
import { transaction } from '#db/tx'
import { createDatabaseQueue, retryDelayMs } from '#queue/driver/database'
import { createSyncQueue } from '#queue/driver/sync'
import { dispatch, prepareJob } from '#queue/queue'
import type { JobCatalog, JobContext } from '#queue/registry'

/**
 * The queue, against a real Postgres.
 *
 * A mocked database would prove that a mock hands out one row at a time. What has to hold
 * is that **two workers hitting one table never run the same job twice**, and that is a
 * property of `FOR UPDATE SKIP LOCKED`, not of any code here.
 *
 * The drivers are constructed **directly** rather than through the module-level `queue`,
 * because `env` is parsed once and frozen at boot: a test cannot flip `QUEUE_DRIVER`. That
 * is the reason every subsystem in this repository ships a factory beside its singleton.
 *
 * The catalog is a test one for the same reason a fixture user is not the seeded owner:
 * a suite that needs a handler which throws must not have to add one to the real registry.
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

function queueFor(overrides: { concurrency?: number; staleAfterMs?: number } = {}) {
  return createDatabaseQueue({ catalog: CATALOG, ...overrides })
}

async function cleanJobs(): Promise<void> {
  await db.delete(jobs).where(like(jobs.name, `${TAG}%`))
}

async function only(name: string): Promise<Job> {
  const rows = await db.select().from(jobs).where(eq(jobs.name, name))
  const [row] = rows
  if (!row) throw new Error(`expected exactly one ${name} row, found ${rows.length}`)
  return row
}

beforeAll(cleanJobs)
afterEach(async () => {
  ran.length = 0
  await cleanJobs()
})
afterAll(cleanJobs)

describe('prepareJob', () => {
  it('rejects a payload the handler could never have used, before anything is written', () => {
    expect(() => prepareJob('test.ok', { note: 42 }, {}, CATALOG)).toThrow(/invalid/)
  })

  it('rejects a name that is not in the catalog', () => {
    expect(() => prepareJob('test.nope', {}, {}, CATALOG)).toThrow(/unknown job/)
  })

  it('normalises the payload to JSON, so every driver hands the handler the same value', () => {
    const job = prepareJob(
      'test.ok',
      { note: 'json', extra: new Date('2026-01-01T00:00:00.000Z') },
      {},
      CATALOG,
    )

    // `extra` is stripped by the schema; what survives has been through JSON once.
    expect(job.payload).toEqual({ note: 'json' })
  })
})

describe('the database driver', () => {
  it('runs a job and records that it succeeded', async () => {
    const queue = queueFor()
    await queue.push(prepareJob('test.ok', { note: 'ran' }, {}, CATALOG))

    expect(await queue.tick()).toBe(1)
    expect(ran).toEqual(['ran'])

    const row = await only('test.ok')
    expect(row.status).toBe('succeeded')
    expect(row.attempts).toBe(1)
    expect(row.finishedAt).not.toBeNull()
    expect(row.lockedBy).toBeNull()
  })

  it('retries a throwing handler, later each time, and keeps the row once it gives up', async () => {
    const queue = queueFor()
    await queue.push(prepareJob('test.throws', {}, { maxAttempts: 2 }, CATALOG))

    await queue.tick()

    const retrying = await only('test.throws')
    expect(retrying.status).toBe('pending')
    expect(retrying.attempts).toBe(1)
    expect(retrying.lastError).toContain('the handler said no')
    // Backoff: the row is not claimable again immediately.
    expect(retrying.runAt.getTime()).toBeGreaterThan(Date.now())

    // Nothing is due, so a tick right now finds nothing at all.
    expect(await queue.tick()).toBe(0)

    await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, retrying.id))
    await queue.tick()

    const dead = await only('test.throws')
    expect(dead.status).toBe('failed')
    expect(dead.attempts).toBe(2)
    expect(dead.finishedAt).not.toBeNull()
  })

  it('fails a job whose handler this build does not have, without spending three attempts', async () => {
    await db.insert(jobs).values({ name: 'test.gone', payload: {}, maxAttempts: 5 })

    await queueFor().tick()

    const row = await only('test.gone')
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(1)
    expect(row.lastError).toContain('no handler is registered')
  })

  /**
   * The reason this suite needs a real database. Two drivers claim at the same instant;
   * `SKIP LOCKED` is what makes the second one walk past the rows the first is holding
   * instead of blocking on them and then running them again.
   */
  it('never lets two workers run the same job', async () => {
    const first = queueFor({ concurrency: 2 })
    const second = queueFor({ concurrency: 2 })

    for (let i = 0; i < 4; i += 1) {
      await first.push(prepareJob('test.slow', {}, {}, CATALOG))
    }

    const [a, b] = await Promise.all([first.tick(), second.tick()])

    expect(a + b).toBe(4)
    expect(ran).toHaveLength(4)
    expect(new Set(ran).size).toBe(4)

    const rows = await db.select().from(jobs).where(eq(jobs.name, 'test.slow'))
    expect(rows.every((row) => row.status === 'succeeded' && row.attempts === 1)).toBe(true)
  })

  it('makes a second enqueue with the same dedupe key a no-op', async () => {
    const queue = queueFor()
    const key = 'test.ok:2026-08-16T03:15:00.000Z'

    await queue.push(prepareJob('test.ok', { note: 'first' }, { dedupeKey: key }, CATALOG))
    await queue.push(prepareJob('test.ok', { note: 'second' }, { dedupeKey: key }, CATALOG))

    const rows = await db.select().from(jobs).where(eq(jobs.dedupeKey, key))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toEqual({ note: 'first' })
  })

  it('hands back a row whose worker died, with the attempt already spent', async () => {
    await db.insert(jobs).values({
      name: 'test.ok',
      payload: { note: 'abandoned' },
      status: 'running',
      attempts: 1,
      lockedAt: new Date(Date.now() - 60_000),
      lockedBy: 'a worker that is no longer with us',
    })

    expect(await queueFor({ staleAfterMs: 1000 }).reap()).toBe(1)

    const row = await only('test.ok')
    expect(row.status).toBe('pending')
    expect(row.lockedBy).toBeNull()
    // Not reset: a job that kills its worker every time still has to run out of attempts.
    expect(row.attempts).toBe(1)
  })

  it('enqueues inside the caller transaction, so a rollback takes the job with it', async () => {
    const queue = queueFor()

    await expect(
      transaction(async (tx, defer) => {
        await dispatch(queue, prepareJob('test.ok', { note: 'rolled back' }, {}, CATALOG), {
          tx,
          defer,
        })
        throw new Error('changed my mind')
      }),
    ).rejects.toThrow('changed my mind')

    const rows = await db.select().from(jobs).where(eq(jobs.name, 'test.ok'))
    expect(rows).toHaveLength(0)
  })

  it('commits the job together with the change that caused it', async () => {
    const queue = queueFor()

    await transaction(async (tx, defer) => {
      await dispatch(queue, prepareJob('test.ok', { note: 'committed' }, {}, CATALOG), {
        tx,
        defer,
      })
    })

    const row = await only('test.ok')
    expect(row.status).toBe('pending')
  })
})

describe('the sync driver', () => {
  it('runs the handler inline, with nothing left in the table', async () => {
    const queue = createSyncQueue({ catalog: CATALOG })

    await queue.push(prepareJob('test.ok', { note: 'inline' }, {}, CATALOG))

    expect(ran).toEqual(['inline'])
    const rows = await db
      .select()
      .from(jobs)
      .where(like(jobs.name, `${TAG}%`))
    expect(rows).toHaveLength(0)
  })

  /** The property the whole test suite rests on: a failing job fails the test. */
  it('rethrows, rather than swallowing the failure the way a real queue would', async () => {
    const queue = createSyncQueue({ catalog: CATALOG })

    await expect(queue.push(prepareJob('test.throws', {}, {}, CATALOG))).rejects.toThrow(
      'the handler said no',
    )
  })

  it('waits for the commit rather than joining the transaction it cannot join', async () => {
    const queue = createSyncQueue({ catalog: CATALOG })

    await expect(
      transaction(async (tx, defer) => {
        await dispatch(queue, prepareJob('test.ok', { note: 'deferred' }, {}, CATALOG), {
          tx,
          defer,
        })
        // Still inside the transaction: the handler must not have run yet.
        expect(ran).toEqual([])
        throw new Error('no commit, no job')
      }),
    ).rejects.toThrow('no commit, no job')

    expect(ran).toEqual([])
  })
})

describe('retryDelayMs', () => {
  it('doubles, within a fifth either way', () => {
    expect(retryDelayMs(1)).toBeGreaterThanOrEqual(800)
    expect(retryDelayMs(1)).toBeLessThanOrEqual(1200)
    expect(retryDelayMs(3)).toBeGreaterThanOrEqual(3200)
    expect(retryDelayMs(3)).toBeLessThanOrEqual(4800)
  })

  it('stops doubling at five minutes, so an attempt is never a day away', () => {
    expect(retryDelayMs(40)).toBeLessThanOrEqual(360_000)
  })
})

describe('the jobs table', () => {
  it('claims in run_at order', async () => {
    const queue = queueFor({ concurrency: 1 })

    await queue.push(prepareJob('test.ok', { note: 'later' }, { delayMs: -1000 }, CATALOG))
    await queue.push(prepareJob('test.ok', { note: 'sooner' }, { delayMs: -5000 }, CATALOG))

    await queue.tick()

    expect(ran).toEqual(['sooner'])
    const pending = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.name, 'test.ok'), eq(jobs.status, 'pending')))
    expect(pending).toHaveLength(1)
  })
})
