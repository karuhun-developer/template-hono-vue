import { db } from '#db/client'
import { env } from '#env'
import { purgeExpiredInvites } from '#platform/invite.repo'
import { purgeExpiredResets } from '#platform/password-reset.repo'
import { pruneDeadSessions } from '#platform/session.repo'
import { reapStaleJobs } from '#queue/queue.repo'
import type { JobContext } from '#queue/registry'

/**
 * The housekeeping jobs.
 *
 * The first three are **hygiene, not correctness**. `findLiveSession()` already filters on
 * `expires_at > now()`, and both token lookups filter on their own expiry, so an expired
 * row grants nothing whether or not it has been swept. What the sweep buys is a table that
 * does not grow forever, and a `psql` session where "one live invitation per user" is
 * visible rather than inferred.
 *
 * That distinction is worth keeping straight: the day one of these stops running, nothing
 * becomes insecure — which is exactly why nobody would notice, and why they are scheduled
 * rather than left to somebody remembering.
 *
 * `queue.reap` is the exception, and the reason it is called out here: work a dead worker
 * was holding stays `running` forever until something hands it back. That one is
 * correctness, and it is the job most worth noticing the absence of.
 *
 * Each is idempotent. Running one twice deletes nothing the first run left behind, so a
 * retry after a half-finished attempt is safe.
 */

export async function pruneSessionsJob(_payload: unknown, ctx: JobContext): Promise<void> {
  const removed = await pruneDeadSessions()
  ctx.logger.info({ removed }, 'pruned expired sessions')
}

export async function purgeInvitesJob(_payload: unknown, ctx: JobContext): Promise<void> {
  const cleared = await purgeExpiredInvites()
  ctx.logger.info({ cleared }, 'purged expired invitations')
}

export async function purgeResetsJob(_payload: unknown, ctx: JobContext): Promise<void> {
  const cleared = await purgeExpiredResets()
  ctx.logger.info({ cleared }, 'purged expired password resets')
}

/**
 * Hand back the jobs a worker died holding.
 *
 * Only the `database` driver leaves rows like that — BullMQ recovers its own stalled jobs —
 * so on any other driver this finds nothing and says so, which is the honest answer rather
 * than a schedule that quietly does not apply.
 *
 * It reaps its own row too, in principle: this job is `running` while it runs, but its
 * `locked_at` is seconds old and the cutoff is `QUEUE_STALE_AFTER_MINUTES`, so it can never
 * be the row it hands back.
 */
export async function reapJobsJob(_payload: unknown, ctx: JobContext): Promise<void> {
  const reaped = await reapStaleJobs(db, {
    olderThanMs: env.QUEUE_STALE_AFTER_MINUTES * 60_000,
  })

  if (reaped > 0) ctx.logger.warn({ reaped }, 'handed back jobs abandoned by a dead worker')
  else ctx.logger.info({ reaped }, 'no abandoned jobs to hand back')
}
