import { sql } from 'drizzle-orm'
import { boolean, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'

import { primaryId, timestamps, timestamptz } from '#db/columns'

/**
 * One row per tick a schedule actually fired.
 *
 * There is **no `schedules` table**. What may be scheduled is code — `src/scheduler/
 * schedules.ts`, the same idiom as `PERMISSIONS` and `JOBS` — because an expression in a
 * row is an expression nothing type-checks, pointing at a job name nothing verifies. Only
 * the state is rows, and this is all of it.
 *
 * The row is written once and never updated. What *happened* is the job's business, and
 * `job_key` is the pointer at it: it holds the dedupe key the tick handed to the queue,
 * which is `jobs.dedupe_key` on the row the queue created. One source of truth for an
 * outcome, rather than a second copy here that could disagree with it.
 */

export const scheduleRuns = pgTable(
  'schedule_runs',
  {
    id: primaryId(),

    /** A key in the `SCHEDULES` registry — see `src/scheduler/schedules.ts`. */
    scheduleKey: text('schedule_key').notNull(),

    /**
     * The exact instant the cron expression was due — **not** the instant we noticed.
     *
     * Every replica computes the same value from the same expression, which is what makes
     * the unique index below a lock: all of them insert, exactly one wins, and the losers
     * get a duplicate key rather than a second job.
     */
    firedFor: timestamptz('fired_for').notNull(),

    /** True when somebody pressed "Run now". Excluded from the index, so it suppresses nothing. */
    manual: boolean('manual').notNull().default(false),

    /**
     * The dedupe key handed to the queue, and the correlation id back to `jobs`.
     *
     * A plain text join rather than a foreign key: under `QUEUE_DRIVER=redis` the queue
     * keeps no row to point at, and a constraint that can only be satisfied by one driver
     * is a constraint that would have to be dropped by the next one.
     */
    jobKey: text('job_key').notNull(),

    ...timestamps(),
  },
  (table) => [
    /**
     * **The lock.** Partial on `manual = false`, so pressing "Run now" twice in the same
     * second is allowed while the tick behind it stays exactly-once — a manual run that
     * could suppress the real one would be a button that silently skips a night's cleanup.
     */
    uniqueIndex('schedule_runs_tick_key')
      .on(table.scheduleKey, table.firedFor)
      .where(sql`${table.manual} = false`),

    /** The console asks one schedule for its recent history, newest first. */
    index('schedule_runs_key_created_idx').on(table.scheduleKey, table.createdAt.desc()),
  ],
)

export type ScheduleRun = typeof scheduleRuns.$inferSelect
export type NewScheduleRun = typeof scheduleRuns.$inferInsert
