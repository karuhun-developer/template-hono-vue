import { and, desc, eq, inArray } from 'drizzle-orm'

import type { Database, DatabaseHandle } from '#db/client'
import { jobs, scheduleRuns, type JobStatus } from '#db/schema'

/**
 * Every read and write of `schedule_runs`.
 *
 * The interesting one is `claimTick`, which is not a read at all: the insert **is** the
 * lock. Everything else here is the console's side — what happened, joined to the job the
 * tick enqueued.
 */

/**
 * What a run turned into, as far as the queue is willing to say.
 *
 * `job` is null under `QUEUE_DRIVER=redis`, where the queue keeps no row to join to unless
 * the job failed terminally — and even then the mirrored row carries no dedupe key, on
 * purpose (see `recordFailedJob`). That is the same per-driver honesty the Jobs page
 * already has, and the console says so rather than rendering an empty cell that reads as
 * "nothing happened".
 *
 * There is no duration. `jobs.locked_at` is cleared when a job finishes, so the only
 * interval still derivable is "due until finished", which includes however long the row sat
 * in the queue — a number that looks like a slow job and is usually a busy worker.
 */
export type ScheduleRunRecord = {
  id: string
  scheduleKey: string
  firedFor: Date
  manual: boolean
  enqueuedAt: Date
  job: {
    id: string
    name: string
    status: JobStatus
    attempts: number
    maxAttempts: number
    lastError: string | null
    finishedAt: Date | null
  } | null
}

/**
 * Selected flat and reassembled below rather than as a nested object, because a left join is
 * what makes every `jobs` column nullable and only the flat form says so in the type.
 */
const runColumns = {
  id: scheduleRuns.id,
  scheduleKey: scheduleRuns.scheduleKey,
  firedFor: scheduleRuns.firedFor,
  manual: scheduleRuns.manual,
  enqueuedAt: scheduleRuns.createdAt,
  jobId: jobs.id,
  jobName: jobs.name,
  jobStatus: jobs.status,
  jobAttempts: jobs.attempts,
  jobMaxAttempts: jobs.maxAttempts,
  jobLastError: jobs.lastError,
  jobFinishedAt: jobs.finishedAt,
} as const

/** What the three queries below all come back as — every joined column nullable. */
type RunRow = {
  id: string
  scheduleKey: string
  firedFor: Date
  manual: boolean
  enqueuedAt: Date
  jobId: string | null
  jobName: string | null
  jobStatus: JobStatus | null
  jobAttempts: number | null
  jobMaxAttempts: number | null
  jobLastError: string | null
  jobFinishedAt: Date | null
}

function toRecord(row: RunRow): ScheduleRunRecord {
  /**
   * Every column is tested rather than only `jobId`, because a left join is all-or-nothing
   * and this is the form that says so to the compiler. Narrowing on one field and asserting
   * the rest would be the same claim, made where nothing checks it.
   */
  const job =
    row.jobId !== null &&
    row.jobName !== null &&
    row.jobStatus !== null &&
    row.jobAttempts !== null &&
    row.jobMaxAttempts !== null
      ? {
          id: row.jobId,
          name: row.jobName,
          status: row.jobStatus,
          attempts: row.jobAttempts,
          maxAttempts: row.jobMaxAttempts,
          lastError: row.jobLastError,
          finishedAt: row.jobFinishedAt,
        }
      : null

  return {
    id: row.id,
    scheduleKey: row.scheduleKey,
    firedFor: row.firedFor,
    manual: row.manual,
    enqueuedAt: row.enqueuedAt,
    job,
  }
}

/**
 * Take ownership of one tick, or discover that somebody else already has.
 *
 * `ON CONFLICT DO NOTHING RETURNING id` against `schedule_runs_tick_key` is the entire
 * cross-replica lock: every worker computes the same `firedFor` from the same expression,
 * every worker inserts, exactly one gets a row back. `true` means "this replica owns this
 * tick and must enqueue the job"; `false` means another one does and there is nothing to do.
 *
 * A lock rather than an advisory lock for two reasons: this one survives a restart, and it
 * leaves behind the rows the console needs anyway. An advisory lock displays nothing and
 * releases the moment its connection drops — which is precisely the moment a duplicate fire
 * is most likely.
 *
 * Runs through the caller's handle, so under the `database` queue driver the claim and the
 * job it enqueues commit together or not at all.
 */
export async function claimTick(
  handle: DatabaseHandle,
  row: { scheduleKey: string; firedFor: Date; jobKey: string },
): Promise<boolean> {
  const inserted = await handle
    .insert(scheduleRuns)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: scheduleRuns.id })

  return inserted.length > 0
}

/** A "Run now". Excluded from the unique index, so it can neither suppress nor be suppressed. */
export async function recordManualRun(
  handle: DatabaseHandle,
  row: { scheduleKey: string; firedFor: Date; jobKey: string },
): Promise<string> {
  const [inserted] = await handle
    .insert(scheduleRuns)
    .values({ ...row, manual: true })
    .returning({ id: scheduleRuns.id })

  // `.returning()` on a plain insert always yields the row; the check is for the type.
  if (!inserted) throw new Error('the manual schedule run was not written')
  return inserted.id
}

/**
 * The newest run of each of the given schedules.
 *
 * `DISTINCT ON` rather than a window function or one query per key: the registry is a
 * handful of rows and this is the shape Postgres does best — the leading columns of
 * `ORDER BY` have to match the `DISTINCT ON` list, which is why the key comes first even
 * though the answer is ordered by time.
 */
export async function latestRunPerSchedule(
  database: Database,
  keys: readonly string[],
): Promise<Map<string, ScheduleRunRecord>> {
  if (keys.length === 0) return new Map()

  const rows = await database
    .selectDistinctOn([scheduleRuns.scheduleKey], runColumns)
    .from(scheduleRuns)
    .leftJoin(jobs, eq(jobs.dedupeKey, scheduleRuns.jobKey))
    .where(inArray(scheduleRuns.scheduleKey, [...keys]))
    .orderBy(scheduleRuns.scheduleKey, desc(scheduleRuns.createdAt))

  return new Map(rows.map((row) => [row.scheduleKey, toRecord(row)]))
}

/** The history drawer: one schedule, newest first, capped by the caller. */
export async function listRunsForSchedule(
  database: Database,
  key: string,
  limit: number,
): Promise<ScheduleRunRecord[]> {
  const rows = await database
    .select(runColumns)
    .from(scheduleRuns)
    .leftJoin(jobs, eq(jobs.dedupeKey, scheduleRuns.jobKey))
    .where(eq(scheduleRuns.scheduleKey, key))
    .orderBy(desc(scheduleRuns.createdAt))
    .limit(limit)

  return rows.map(toRecord)
}

/** Used by the tick tests, and by nothing in production. */
export async function findRun(
  database: Database,
  key: string,
  firedFor: Date,
): Promise<ScheduleRunRecord | null> {
  const [row] = await database
    .select(runColumns)
    .from(scheduleRuns)
    .leftJoin(jobs, eq(jobs.dedupeKey, scheduleRuns.jobKey))
    .where(and(eq(scheduleRuns.scheduleKey, key), eq(scheduleRuns.firedFor, firedFor)))
    .limit(1)

  return row ? toRecord(row) : null
}
