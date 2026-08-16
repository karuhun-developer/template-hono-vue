import { and, eq, isNotNull, lt, sql } from 'drizzle-orm'

import type { Database, DatabaseHandle } from '#db/client'
import { jobs } from '#db/schema'

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
