import type { Logger } from 'pino'
import { z } from 'zod'

import { purgeInvitesJob, purgeResetsJob, pruneSessionsJob, reapJobsJob } from '#queue/jobs/cleanup'
import { pruneMailJob, sendMailJob, sweepStuckMailJob } from '#queue/jobs/mail'

/**
 * The catalog of everything that can be enqueued.
 *
 * Same idiom as `PERMISSIONS` in `@app/contract`: one `as const satisfies` object, and the
 * names and payload types are **derived** from it. `enqueue('mial.send', …)` is therefore a
 * compile error rather than a row nobody ever claims.
 *
 * > **Payloads are JSON, and only JSON.** A `Date` goes into `jsonb` as a string and comes
 * > back as a string, so a schema here uses `z.iso.datetime()` or an id — never `z.date()`.
 * > Getting this wrong looks like a bug inside the handler, which is why it is stated here,
 * > at the only place a payload shape is declared.
 *
 * The payload is validated **twice**: on enqueue, so a bad payload fails inside the
 * caller's transaction rather than three retries later in a worker log, and on dequeue,
 * because a row can be older than the code that reads it.
 */

/** What a handler is told about the attempt it is running in. */
export type JobContext = {
  readonly name: string
  /** The `jobs.id` this attempt belongs to. The sync driver invents one; nothing reads it back. */
  readonly jobId: string
  /** 1 on the first attempt. */
  readonly attempt: number
  /**
   * How many attempts this job gets under the configured driver — 1 under `sync`, which
   * does not retry. `attempt >= maxAttempts` is how a handler knows it is on its last
   * chance, which is what lets one clean up material it must not leave behind.
   */
  readonly maxAttempts: number
  /** Already carrying `{ job, jobId }`. Background work has no request, so no `c.get('logger')`. */
  readonly logger: Logger
  /** Aborted when the worker is shutting down and the grace period has run out. */
  readonly signal: AbortSignal
}

/**
 * `never` as the payload parameter is deliberate: parameters are contravariant, so every
 * concrete handler is assignable to this, and the catalog below can hold handlers of
 * different payload types without a cast.
 */
export type JobDefinition = {
  readonly payload: z.ZodType
  readonly handler: (payload: never, ctx: JobContext) => Promise<void>
  /** Overrides `QUEUE_MAX_ATTEMPTS` for this job alone. */
  readonly maxAttempts?: number
}

export type JobCatalog = Record<string, JobDefinition>

/**
 * A job that takes no arguments still takes an object, so that adding a field later is a
 * schema change rather than a change of shape.
 */
const NO_PAYLOAD = z.object({})

export const JOBS = {
  /** The cleanup `pruneDeadSessions()` has been asking for in its own comment. */
  'sessions.prune': { payload: NO_PAYLOAD, handler: pruneSessionsJob },
  'invites.purge': { payload: NO_PAYLOAD, handler: purgeInvitesJob },
  'password-resets.purge': { payload: NO_PAYLOAD, handler: purgeResetsJob },

  /**
   * An id, not the message. The row is the source of truth and the job is a pointer at it,
   * so a retry re-reads what actually happened rather than re-sending a copy of what was
   * true when it was enqueued.
   */
  'mail.send': { payload: z.object({ messageId: z.uuid() }), handler: sendMailJob },
  'mail.sweep-stuck': { payload: NO_PAYLOAD, handler: sweepStuckMailJob },
  'mail.prune': { payload: NO_PAYLOAD, handler: pruneMailJob },

  /**
   * One attempt, deliberately. It runs every five minutes anyway, so a retry would only
   * repeat work the next tick was going to do — and a reaper that piles up retries while
   * the database is unwell is the last thing that database needs.
   */
  'queue.reap': { payload: NO_PAYLOAD, handler: reapJobsJob, maxAttempts: 1 },
} as const satisfies JobCatalog

export type JobName = keyof typeof JOBS

export type JobPayload<N extends JobName> = z.infer<(typeof JOBS)[N]['payload']>

export function isJobName(value: string): value is JobName {
  return Object.hasOwn(JOBS, value)
}

export const JOB_NAMES = Object.keys(JOBS) as JobName[]
