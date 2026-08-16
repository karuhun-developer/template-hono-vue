import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'

import { primaryId, timestamps, timestamptz } from '#db/columns'

/**
 * Background work: one row per attempt-bearing unit of work.
 *
 * This table is the **queue** when `QUEUE_DRIVER=database`, and the **record of what
 * happened** whatever the driver is — the Redis driver mirrors terminal outcomes back into
 * it, so one console page can list jobs regardless of how they were carried. That is the
 * reason a finished row is kept rather than deleted; `queue.reap` and a retention window
 * are what keep the table from growing forever.
 */

/**
 * `pending` is the only status the claim query looks at, which is why it is also the
 * default: a row is claimable the moment it is committed.
 *
 * `cancelled` is separate from `failed` on purpose. A failure is something to investigate;
 * a cancellation is somebody deciding the work is no longer wanted, and merging the two
 * would make the Jobs page unable to tell them apart.
 */
export const jobStatus = pgEnum('job_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

export type JobStatus = (typeof jobStatus.enumValues)[number]

export const jobs = pgTable(
  'jobs',
  {
    id: primaryId(),

    /** A key in the `JOBS` catalog — see `src/queue/registry.ts`. */
    name: text('name').notNull(),

    /**
     * The handler's argument, **JSON and nothing else**. A `Date` put in here comes back
     * out as a string, so every payload schema uses an ISO string or an id rather than
     * `z.date()`. It is validated on the way in and again on the way out, because a row can
     * outlive the code that wrote it.
     */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    status: jobStatus('status').notNull().default('pending'),

    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),

    /**
     * When the job becomes claimable. A delay and a retry backoff are the same thing seen
     * from two directions, so both are written here rather than in two columns.
     */
    runAt: timestamptz('run_at').notNull().defaultNow(),

    /**
     * Who is holding the row, and since when. Not a lock — the claim already took one for
     * the length of a statement — but the evidence a worker that died mid-job leaves
     * behind, which is what lets `reapStale()` hand the work to somebody else.
     */
    lockedAt: timestamptz('locked_at'),
    lockedBy: text('locked_by'),

    lastError: text('last_error'),
    finishedAt: timestamptz('finished_at'),

    /**
     * Set by the scheduler: `<schedule>:<fired_for>`. The unique index below is what makes
     * "enqueue this tick at most once" true even when two replicas both decide to.
     */
    dedupeKey: text('dedupe_key'),

    ...timestamps(),
  },
  (table) => [
    /**
     * Partial, and the predicate is the point: a table full of finished jobs must not slow
     * down finding the next pending one. The order matches the claim query's `ORDER BY`.
     */
    index('jobs_claim_idx')
      .on(table.runAt, table.id)
      .where(sql`${table.status} = 'pending'`),

    /** The console asks "what happened recently", optionally narrowed by status. */
    index('jobs_status_created_idx').on(table.status, table.createdAt.desc()),

    /** Partial for the same reason as the invitation token index: almost every row is NULL. */
    uniqueIndex('jobs_dedupe_key')
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} IS NOT NULL`),
  ],
)

export type Job = typeof jobs.$inferSelect
export type NewJob = typeof jobs.$inferInsert
