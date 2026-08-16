import { db } from '#db/client'
import { env } from '#env'
import { notFound } from '#lib/errors'
import { recordAudit, type AuditActor } from '#modules/audit/audit.repo'
import { nextRunAt } from '#scheduler/cron'
import {
  latestRunPerSchedule,
  listRunsForSchedule,
  type ScheduleRunRecord,
} from '#scheduler/schedule.repo'
import { findSchedule, SCHEDULES } from '#scheduler/schedules'
import { scheduler, type Scheduler } from '#scheduler/scheduler'

/**
 * The Scheduled jobs page's side of the scheduler.
 *
 * The registry is code, so there is nothing here that edits a schedule — no create, no
 * update, no pause. Turning one off is a deploy, which is the whole argument for keeping the
 * expressions in a file rather than in a table; an endpoint that quietly reintroduced the
 * table would undo it.
 *
 * `runScheduleNow` takes the scheduler as a **last argument defaulting to the singleton**,
 * for the same reason the jobs service takes the queue admin that way: `env` is frozen at
 * boot, so without the seam a test could not watch what the button enqueued.
 */

export type ScheduleSummary = {
  key: string
  cron: string
  job: string
  description: string
  /**
   * Computed on every request and **never stored**. A stored next-run is a value that goes
   * stale the moment somebody edits the expression, and the staleness is invisible: the page
   * would keep confidently naming an instant nothing is going to fire at.
   */
  nextRunAt: Date | null
  lastRun: ScheduleRunRecord | null
}

export type ScheduleListPage = {
  items: ScheduleSummary[]
  /** The zone every expression above is read in — an instant means nothing without it. */
  timezone: string
  /**
   * Whether a worker is ticking these at all. False is a legitimate configuration, and a
   * page that did not say so would show six schedules, six next-run times, and no runs, which
   * reads as a broken scheduler rather than a disabled one.
   */
  enabled: boolean
}

export async function listSchedules(now: Date = new Date()): Promise<ScheduleListPage> {
  const latest = await latestRunPerSchedule(
    db,
    SCHEDULES.map((schedule) => schedule.key),
  )

  return {
    items: SCHEDULES.map((schedule) => ({
      key: schedule.key,
      cron: schedule.cron,
      job: schedule.job,
      description: schedule.description,
      nextRunAt: nextRunAt(schedule.cron, env.SCHEDULER_TIMEZONE, now),
      lastRun: latest.get(schedule.key) ?? null,
    })),
    timezone: env.SCHEDULER_TIMEZONE,
    enabled: env.SCHEDULER_ENABLED,
  }
}

/**
 * The history drawer.
 *
 * A 404 for a key that is not in the registry, rather than an empty list: the two mean very
 * different things, and "no runs yet" is the answer somebody would act on.
 */
export async function listScheduleRuns(key: string, limit: number): Promise<ScheduleRunRecord[]> {
  if (!findSchedule(key)) throw notFound('Schedule not found.')

  return listRunsForSchedule(db, key, limit)
}

/**
 * "Run now".
 *
 * The audit entry is written **outside** the scheduler's transaction, which is the one place
 * in this codebase where that is deliberate. `fireManually` owns its transaction because the
 * run row and the job it enqueues have to commit together; joining it would mean threading a
 * handle through the scheduler for the benefit of one caller. The entry records a button
 * press whose effect has already, definitively, happened — so there is no state where the
 * trail disagrees with the change, only one where an entry is missing.
 *
 * Deliberately **not** gated on `SCHEDULER_ENABLED`. That setting decides whether the clock
 * is watched; the button does not watch the clock. A deployment that ticks nothing on purpose
 * can still have somebody press "run the cleanup", and the worker will drain it.
 */
export async function runScheduleNow(
  actor: AuditActor,
  key: string,
  instance: Scheduler = scheduler,
): Promise<{ runId: string; jobKey: string; schedule: string; job: string }> {
  const schedule = findSchedule(key)
  if (!schedule) throw notFound('Schedule not found.')

  const { runId, jobKey } = await instance.fireManually(schedule.key)

  await recordAudit(db, actor, {
    action: 'schedule.run',
    subjectType: 'schedule_runs',
    subjectId: runId,
    subjectLabel: schedule.key,
    after: { job: schedule.job, jobKey },
  })

  return { runId, jobKey, schedule: schedule.key, job: schedule.job }
}
