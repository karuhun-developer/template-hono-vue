import type { Logger } from 'pino'
import { z } from 'zod'

import { purgeInvitesJob, purgeResetsJob, pruneSessionsJob } from '#queue/jobs/cleanup'

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
} as const satisfies JobCatalog

export type JobName = keyof typeof JOBS

export type JobPayload<N extends JobName> = z.infer<(typeof JOBS)[N]['payload']>

export function isJobName(value: string): value is JobName {
  return Object.hasOwn(JOBS, value)
}

export const JOB_NAMES = Object.keys(JOBS) as JobName[]
