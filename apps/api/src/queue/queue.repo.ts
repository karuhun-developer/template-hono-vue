import { and, asc, count, desc, eq, inArray, isNotNull, lt, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import type { Database, DatabaseHandle } from '#db/client'
import { jobs, type Job, type JobStatus } from '#db/schema'

/**
 * Every read and write of the `jobs` table.
 *
 * The claim is raw `sql`. `FOR UPDATE SKIP LOCKED` inside a CTE is the one query in this
 * repository worth writing by hand, because it is the whole concurrency story: without
 * `SKIP LOCKED` two workers block on each other and the second one runs the same job the
 * moment the first commits.
 */

export type NewJobRow = {
  name: string
  payload: Record<string, unknown>
  runAt: Date
  maxAttempts: number
  dedupeKey: string | null
}

export type ClaimedJob = {
  id: string
  name: string
  payload: Record<string, unknown>
  attempts: number
  maxAttempts: number
}

/**
 * Returns `false` when the row was deduplicated away.
 *
 * `ON CONFLICT DO NOTHING` with no target on purpose: the only unique index that can be
 * violated here is `jobs_dedupe_key`, and naming a **partial** index in a conflict target
 * means repeating its predicate — a second copy of a rule that would then have to be kept
 * in step with the schema.
 */
export async function insertJob(handle: DatabaseHandle, row: NewJobRow): Promise<boolean> {
  const inserted = await handle
    .insert(jobs)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: jobs.id })

  return inserted.length > 0
}

/**
 * Take up to `limit` due jobs and mark them running, in one statement.
 *
 * One statement matters: a `SELECT` followed by an `UPDATE` leaves a window in which a
 * second worker sees the same rows. The CTE holds the row locks taken by `FOR UPDATE`
 * until the `UPDATE` in the same statement commits, and `SKIP LOCKED` sends every other
 * worker straight past them instead of queuing behind them.
 *
 * `attempts` is incremented **here**, at claim time rather than at completion, so a worker
 * that dies mid-job has still spent an attempt. Otherwise a job that reliably kills its
 * worker is retried forever.
 */
export async function claimJobs(
  database: Database,
  options: { limit: number; workerId: string },
): Promise<ClaimedJob[]> {
  const result = await database.execute<{
    id: string
    name: string
    payload: Record<string, unknown>
    attempts: number
    max_attempts: number
  }>(sql`
    WITH claimed AS (
      SELECT id FROM ${jobs}
      WHERE ${jobs.status} = 'pending' AND ${jobs.runAt} <= now()
      ORDER BY ${jobs.runAt}, ${jobs.id}
      LIMIT ${options.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${jobs} SET
      status = 'running',
      attempts = ${jobs.attempts} + 1,
      locked_at = now(),
      locked_by = ${options.workerId},
      updated_at = now()
    WHERE ${jobs.id} IN (SELECT id FROM claimed)
    RETURNING ${jobs.id}, ${jobs.name}, ${jobs.payload}, ${jobs.attempts}, ${jobs.maxAttempts}
  `)

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  }))
}

export async function markSucceeded(database: Database, id: string): Promise<void> {
  await database
    .update(jobs)
    .set({
      status: 'succeeded',
      finishedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, id))
}

/**
 * A failed attempt: back to `pending` with a later `run_at`, or terminal.
 *
 * The row is **kept** when it lands `failed`. A queue that deletes what went wrong is a
 * queue with no answer to "what went wrong", and the console's Jobs page lists exactly
 * these rows.
 */
export async function markFailed(
  database: Database,
  id: string,
  options: { error: string; retryAt: Date | null },
): Promise<void> {
  const terminal = options.retryAt === null

  await database
    .update(jobs)
    .set({
      status: terminal ? 'failed' : 'pending',
      lastError: options.error,
      finishedAt: terminal ? new Date() : null,
      runAt: options.retryAt ?? undefined,
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, id))
}

/**
 * Write a job that has already failed for the last time, somewhere else.
 *
 * Only the redis driver calls this. BullMQ keeps its own failure records, but they live in
 * Redis, expire with `removeOnFail`, and vanish entirely with a `FLUSHALL` — so a Jobs page
 * reading them would show a different history depending on `QUEUE_DRIVER`. Mirroring the
 * terminal failures into `jobs` gives one durable answer to "what went wrong" regardless of
 * which transport carried it.
 *
 * Only failures. Mirroring successes too would put every job through Postgres anyway, which
 * is the entire cost the redis driver exists to avoid.
 *
 * `dedupe_key` is deliberately left null: a mirrored row is history, and a historical row
 * holding the unique key would silently reject the next enqueue that reuses it.
 */
export async function recordFailedJob(
  database: Database,
  row: {
    name: string
    payload: Record<string, unknown>
    attempts: number
    maxAttempts: number
    error: string
    lockedBy: string
  },
): Promise<void> {
  const now = new Date()

  await database.insert(jobs).values({
    name: row.name,
    payload: row.payload,
    status: 'failed',
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAt: now,
    lockedBy: row.lockedBy,
    lastError: row.error,
    finishedAt: now,
  })
}

/**
 * Hand back the rows a dead worker was holding.
 *
 * `running` with a `locked_at` older than the stale window means the process that claimed
 * the row is gone — a live worker finishes or fails a job in seconds. Their attempt has
 * already been counted, so a job that kills its worker every time still reaches
 * `max_attempts` and stops.
 */
export async function reapStaleJobs(
  database: Database,
  options: { olderThanMs: number },
): Promise<number> {
  const cutoff = new Date(Date.now() - options.olderThanMs)

  const reaped = await database
    .update(jobs)
    .set({ status: 'pending', lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(and(eq(jobs.status, 'running'), isNotNull(jobs.lockedAt), lt(jobs.lockedAt, cutoff)))
    .returning({ id: jobs.id })

  return reaped.length
}

// --- Reading and administering ----------------------------------------------

/**
 * The orderings the Jobs page offers, mapped to the columns behind them.
 *
 * A whitelist for the same reason `users.repo.ts` has one: `sort` arrives from a query
 * string, and the only thing keeping SQL out of the `ORDER BY` is that the value is used
 * to *pick* from this object rather than being interpolated into it.
 */
const SORTABLE = {
  createdAt: jobs.createdAt,
  runAt: jobs.runAt,
  name: jobs.name,
  status: jobs.status,
} as const satisfies Record<string, PgColumn>

export type ListJobsSort = keyof typeof SORTABLE

export type ListJobsFilter = {
  /** Any of these statuses. Empty or absent means all of them. */
  status?: readonly JobStatus[] | undefined
  /** Exact match on the catalog name — the console offers it as a facet, not a search. */
  name?: readonly string[] | undefined
  page: number
  perPage: number
  sort: ListJobsSort
  order: 'asc' | 'desc'
}

export type ListJobsPage = {
  rows: Job[]
  /** Rows matching the filter, not rows returned — the pager needs the first number. */
  total: number
}

export async function listJobs(database: Database, filter: ListJobsFilter): Promise<ListJobsPage> {
  const where: SQL[] = []
  if (filter.status?.length) where.push(inArray(jobs.status, [...filter.status]))
  if (filter.name?.length) where.push(inArray(jobs.name, [...filter.name]))

  const condition = where.length > 0 ? and(...where) : undefined
  const direction = filter.order === 'desc' ? desc : asc

  const [rows, [counted]] = await Promise.all([
    database
      .select()
      .from(jobs)
      .where(condition)
      // `id` breaks ties, for the reason the user list gives: two pages of an unstable
      // sort can show one row twice and skip another entirely.
      .orderBy(direction(SORTABLE[filter.sort]), asc(jobs.id))
      .limit(filter.perPage)
      .offset((filter.page - 1) * filter.perPage),

    // The same `where`, deliberately. A count over a different condition is a pager that
    // promises pages which are not there.
    database.select({ value: count() }).from(jobs).where(condition),
  ])

  return { rows, total: counted?.value ?? 0 }
}

export async function findJob(handle: DatabaseHandle, id: string): Promise<Job | null> {
  const [row] = await handle.select().from(jobs).where(eq(jobs.id, id)).limit(1)
  return row ?? null
}

/**
 * Put a job that has stopped back in line.
 *
 * `attempts` goes back to zero rather than continuing where it left off. A retry is a
 * decision somebody made after looking at `last_error` — usually after fixing whatever
 * caused it — so giving the job one attempt from a budget it has already exhausted would
 * make the button useless exactly when it is pressed.
 *
 * `last_error` is kept. It is the reason the row was retried, and clearing it would erase
 * the answer to "what was wrong with it" the moment somebody acted on it.
 */
export async function requeueJob(handle: DatabaseHandle, id: string): Promise<Job> {
  const [row] = await handle
    .update(jobs)
    .set({
      status: 'pending',
      attempts: 0,
      runAt: new Date(),
      finishedAt: null,
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, id))
    .returning()

  if (!row) throw new Error(`the job ${id} could not be read back after being requeued`)
  return row
}

/** Stop a job that has not run yet. Terminal: `cancelled` is not claimable. */
export async function cancelJob(handle: DatabaseHandle, id: string): Promise<Job> {
  const [row] = await handle
    .update(jobs)
    .set({
      status: 'cancelled',
      finishedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, id))
    .returning()

  if (!row) throw new Error(`the job ${id} could not be read back after being cancelled`)
  return row
}
