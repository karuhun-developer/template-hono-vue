import { eq, like } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { db } from '#db/client'
import { jobs, scheduleRuns } from '#db/schema'
import { createDatabaseQueue } from '#queue/driver/database'
import { dispatch, prepareJob } from '#queue/queue'
import { listRunsForSchedule } from '#scheduler/schedule.repo'
import { createScheduler, type ScheduleEnqueue } from '#scheduler/scheduler'
import type { ScheduleDefinition } from '#scheduler/schedules'

/**
 * The scheduler, against a real Postgres.
 *
 * The property worth a database is the one a mock cannot have: **two schedulers computing
 * the same due instant produce exactly one run row and exactly one job.** That is
 * `schedule_runs_tick_key` doing its work, not any code in this repository, and the only way
 * to see it is to make two of them race.
 *
 * Everything is constructed directly rather than through the module singleton — `env` is
 * frozen at boot, so a test cannot flip `SCHEDULER_ENABLED` — and `tick(now)` takes the
 * instant, so nothing here waits for a timer to decide it is time.
 */

const TAG = 'test.sched'

/**
 * A registry of its own, tagged, so this suite owns every row it makes. The **jobs** are
 * real: what is being tested is the enqueue, and a fake job name would test a fake enqueue.
 * Nothing ever claims them — no worker is started here — so no handler runs.
 *
 * The two expressions are deliberately hours apart, so a `now` can make one due and not the
 * other. A five-minute schedule and a nightly 03:15 one would both be due at 03:16, and
 * every assertion about how many fired would be counting two things at once.
 */
const SCHEDULES: readonly ScheduleDefinition[] = [
  {
    key: `${TAG}.frequent`,
    cron: '*/5 * * * *',
    job: 'queue.reap',
    description: 'Every five minutes.',
  },
  {
    key: `${TAG}.nightly`,
    cron: '15 5 * * *',
    job: 'sessions.prune',
    description: 'Once a day at 05:15.',
  },
]

const HOUR = 60 * 60 * 1000

/**
 * The real enqueue, through the `database` driver, so the tick's transaction is exercised as
 * it is in production: the claim and the job commit together or not at all.
 *
 * Constructed once and never started. A driver that is only ever pushed to is a writer, and
 * a poll loop in this suite would claim the very rows the assertions are about.
 */
const writer = createDatabaseQueue()

const enqueueThroughDatabase: ScheduleEnqueue = (job, options) =>
  dispatch(writer, prepareJob(job, {}, { dedupeKey: options.dedupeKey }), options)

function schedulerFor(enqueueJob: ScheduleEnqueue = enqueueThroughDatabase) {
  return createScheduler({ schedules: SCHEDULES, timezone: 'UTC', catchupMs: HOUR, enqueueJob })
}

const at = (iso: string): Date => new Date(iso)

async function clean(): Promise<void> {
  await db.delete(scheduleRuns).where(like(scheduleRuns.scheduleKey, `${TAG}%`))
  await db.delete(jobs).where(like(jobs.dedupeKey, `${TAG}%`))
}

async function runsFor(key: string) {
  return listRunsForSchedule(db, key, 50)
}

beforeAll(clean)
afterEach(clean)

describe('a tick', () => {
  it('claims the most recent due instant and enqueues its job', async () => {
    const fired = await schedulerFor().tick(at('2026-08-16T03:16:42.000Z'))

    // Only the five-minute schedule is due inside the hour-wide window at 03:16.
    expect(fired).toBe(1)

    const runs = await runsFor(`${TAG}.frequent`)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.firedFor).toEqual(at('2026-08-16T03:15:00.000Z'))
    expect(runs[0]?.manual).toBe(false)

    // The join back to `jobs` through the dedupe key is what the console reads.
    expect(runs[0]?.job?.name).toBe('queue.reap')
    expect(runs[0]?.job?.status).toBe('pending')
  })

  it('is idempotent — ticking the same instant again claims nothing', async () => {
    const scheduler = schedulerFor()

    await scheduler.tick(at('2026-08-16T03:16:00.000Z'))
    const second = await scheduler.tick(at('2026-08-16T03:17:00.000Z'))

    // 03:17 still resolves to the 03:15 occurrence, which is already owned.
    expect(second).toBe(0)
    expect(await runsFor(`${TAG}.frequent`)).toHaveLength(1)
  })

  /**
   * **The correctness test.** Two schedulers, one instant, no coordination between them
   * beyond the unique index — which is the situation two worker replicas are in every
   * thirty seconds.
   */
  it('produces exactly one run and one job when two schedulers race', async () => {
    const now = at('2026-08-16T03:16:00.000Z')

    const [a, b] = await Promise.all([schedulerFor().tick(now), schedulerFor().tick(now)])

    // One of them won; which one is not the point, and is not deterministic.
    expect(a + b).toBe(1)

    const runs = await runsFor(`${TAG}.frequent`)
    expect(runs).toHaveLength(1)

    const rows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, `${TAG}.frequent:2026-08-16T03:15:00.000Z`))
    expect(rows).toHaveLength(1)
  })

  it('skips an occurrence older than the catch-up window', async () => {
    // 09:00, with an hour to look back through: this morning's 05:15 is long gone. A worker
    // that has been down since dawn fires nothing rather than firing dawn.
    await schedulerFor().tick(at('2026-08-16T09:00:00.000Z'))

    expect(await runsFor(`${TAG}.nightly`)).toHaveLength(0)
  })

  it('fires a schedule that is due inside the window even after a restart', async () => {
    await schedulerFor().tick(at('2026-08-16T05:45:00.000Z'))

    const runs = await runsFor(`${TAG}.nightly`)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.firedFor).toEqual(at('2026-08-16T05:15:00.000Z'))
  })

  it('rolls the claim back when the enqueue fails, so the next tick retries it', async () => {
    const failing: ScheduleEnqueue = () => Promise.reject(new Error('the queue said no'))

    // The tick swallows it — one broken schedule must not stop the others — and leaves
    // nothing behind, which is what makes the retry on the next pass correct rather than a
    // second attempt at a tick that already counted.
    await expect(schedulerFor(failing).tick(at('2026-08-16T03:16:00.000Z'))).resolves.toBe(0)
    expect(await runsFor(`${TAG}.frequent`)).toHaveLength(0)

    const recovered = await schedulerFor().tick(at('2026-08-16T03:16:00.000Z'))
    expect(recovered).toBe(1)
  })

  it('carries on with the other schedules when one of them fails', async () => {
    const failFrequent: ScheduleEnqueue = (job, options) =>
      options.dedupeKey.startsWith(`${TAG}.frequent`)
        ? Promise.reject(new Error('the queue said no'))
        : enqueueThroughDatabase(job, options)

    // 05:45: both are due inside the window, and the broken one is first in the registry.
    await schedulerFor(failFrequent).tick(at('2026-08-16T05:45:00.000Z'))

    expect(await runsFor(`${TAG}.frequent`)).toHaveLength(0)
    expect(await runsFor(`${TAG}.nightly`)).toHaveLength(1)
  })
})

describe('run now', () => {
  it('records a manual run and enqueues immediately', async () => {
    const { runId } = await schedulerFor().fireManually(`${TAG}.frequent`)

    const runs = await runsFor(`${TAG}.frequent`)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.id).toBe(runId)
    expect(runs[0]?.manual).toBe(true)
    expect(runs[0]?.job?.name).toBe('queue.reap')
  })

  /**
   * The reason `schedule_runs_tick_key` is partial. A manual run that occupied the index
   * would be a button that silently skipped whatever was due in the same minute.
   */
  it('neither suppresses the real tick nor is suppressed by it', async () => {
    const scheduler = schedulerFor()

    await scheduler.tick(at('2026-08-16T03:16:00.000Z'))
    await scheduler.fireManually(`${TAG}.frequent`)
    await scheduler.fireManually(`${TAG}.frequent`)

    const runs = await runsFor(`${TAG}.frequent`)
    expect(runs).toHaveLength(3)
    expect(runs.filter((run) => run.manual)).toHaveLength(2)
  })

  it('refuses a key that is not in the registry', async () => {
    await expect(schedulerFor().fireManually('nope')).rejects.toThrow('unknown schedule "nope"')
  })
})
