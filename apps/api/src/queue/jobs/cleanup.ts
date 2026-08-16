import { purgeExpiredInvites } from '#platform/invite.repo'
import { purgeExpiredResets } from '#platform/password-reset.repo'
import { pruneDeadSessions } from '#platform/session.repo'
import type { JobContext } from '#queue/registry'

/**
 * The three housekeeping jobs.
 *
 * All of them are **hygiene, not correctness**. `findLiveSession()` already filters on
 * `expires_at > now()`, and both token lookups filter on their own expiry, so an expired
 * row grants nothing whether or not it has been swept. What the sweep buys is a table that
 * does not grow forever, and a `psql` session where "one live invitation per user" is
 * visible rather than inferred.
 *
 * That distinction is worth keeping straight: the day one of these stops running, nothing
 * becomes insecure — which is exactly why nobody would notice, and why they are scheduled
 * rather than left to somebody remembering.
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
