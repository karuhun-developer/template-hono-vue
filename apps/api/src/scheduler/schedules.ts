import { env } from '#env'
import type { JobName, JobPayload } from '#queue/registry'
import { parseCron } from '#scheduler/cron'

/**
 * What runs periodically, and when.
 *
 * A code registry, the same `as const satisfies` idiom as `PERMISSIONS` and `JOBS`, and for
 * the same reason: `job` is typed `JobName`, so a schedule pointing at a job that does not
 * exist is a compile error rather than a tick that enqueues something nothing claims.
 *
 * **Deliberately not a table.** An expression in a row is an expression nothing type-checks,
 * editable by anyone with the permission, with no review and no history — and the first
 * thing anybody would want is to disable one, which is a deploy in this design and a
 * mystery in the other. Only the *runs* are rows; see `db/schema/schedules.ts`.
 *
 * A schedule **enqueues a job, it never runs work inline**. Retries, the failure record and
 * the Jobs page all come for free that way, and a cleanup that takes four minutes cannot
 * hold up the tick behind it.
 */

/**
 * The jobs a schedule is allowed to point at: the ones that take no arguments.
 *
 * A cron expression carries a time and nothing else, so there is nowhere for a payload to
 * come from — and the alternative, a payload written into the registry beside the
 * expression, would be a constant pretending to be an argument. Pointing a schedule at
 * `mail.send` is therefore a compile error, which is the right answer: that job needs to be
 * told *which* message.
 */
export type ScheduledJobName = {
  [N in JobName]: Record<never, never> extends JobPayload<N> ? N : never
}[JobName]

export type ScheduleDefinition = {
  readonly key: string
  /** Standard five-field cron, read in `SCHEDULER_TIMEZONE`. */
  readonly cron: string
  readonly job: ScheduledJobName
  /** Shown on the console's Scheduled jobs page. */
  readonly description: string
}

export const SCHEDULES = [
  {
    key: 'sessions.prune',
    cron: '15 3 * * *',
    job: 'sessions.prune',
    description: 'Delete expired and revoked sessions.',
  },
  {
    key: 'invites.purge',
    cron: '30 3 * * *',
    job: 'invites.purge',
    description: 'Clear invitation tokens that have expired.',
  },
  {
    key: 'password-resets.purge',
    cron: '35 3 * * *',
    job: 'password-resets.purge',
    description: 'Clear password reset tokens that have expired.',
  },
  {
    key: 'mail.prune',
    cron: '0 4 * * *',
    job: 'mail.prune',
    description: 'Delete mail log entries past the retention window.',
  },
  {
    key: 'mail.sweep-stuck',
    cron: '*/5 * * * *',
    job: 'mail.sweep-stuck',
    description: 'Re-enqueue messages still queued after five minutes.',
  },
  {
    key: 'queue.reap',
    cron: '*/5 * * * *',
    job: 'queue.reap',
    description: 'Hand back jobs a worker died holding.',
  },
] as const satisfies readonly ScheduleDefinition[]

export type ScheduleKey = (typeof SCHEDULES)[number]['key']

/**
 * Every expression is parsed **at module load**, in the configured timezone.
 *
 * A typo therefore takes the process down at boot, next to a stack trace naming the
 * schedule, instead of at 03:15 on the night somebody needed the cleanup to have run. The
 * timezone is included because croner validates it lazily — an unknown zone throws on the
 * first `nextRun()`, which without this line would be inside a tick, in a worker, swallowed
 * and logged.
 */
for (const schedule of SCHEDULES) {
  try {
    parseCron(schedule.cron, env.SCHEDULER_TIMEZONE).nextRun()
  } catch (err) {
    throw new Error(
      `the schedule "${schedule.key}" has an unusable cron expression "${schedule.cron}" in timezone ${env.SCHEDULER_TIMEZONE}: ${String(err)}`,
    )
  }
}

export function findSchedule(key: string): ScheduleDefinition | undefined {
  return SCHEDULES.find((schedule) => schedule.key === key)
}
