import { and, eq, gt, isNull, sql } from 'drizzle-orm'

import { db } from '#db/client'
import { users } from '#db/schema'
import { hashToken } from '#lib/token'

/**
 * Invitation lookups — again, **before** there is a session.
 *
 * Whoever clicks an invitation link has no session yet, which is why this sits under
 * `src/platform/**` alongside the sign-in queries. The only input it accepts is a **token
 * hash**: a value that limits itself.
 */

export type PendingInvite = {
  userId: string
  email: string
  name: string
  expiresAt: Date
}

/**
 * An invitation that can still be used.
 *
 * Expiry and status are filtered **in SQL**, not after the row is read. The difference is
 * not tidiness: an invitation that has timed out must never get as far as handing the
 * person's name and email back to whoever is holding an old link.
 */
export async function findPendingInvite(token: string): Promise<PendingInvite | null> {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      expiresAt: users.inviteExpiresAt,
    })
    .from(users)
    .where(
      and(
        eq(users.inviteTokenHash, hashToken(token)),
        eq(users.status, 'invited'),
        isNull(users.deletedAt),
        gt(users.inviteExpiresAt, new Date()),
      ),
    )
    .limit(1)

  if (!row?.expiresAt) return null

  return { ...row, expiresAt: row.expiresAt }
}

/**
 * Trade an invitation for a password. Returns `null` when nothing changed.
 *
 * The `WHERE` clause carries the token hash as well, so two requests arriving together
 * from a double-clicked button can only let one of them win — the loser sees zero rows
 * and is answered like an expired link, rather than overwriting the password the winner
 * just set.
 */
export async function acceptInvite(token: string, passwordHash: string): Promise<string | null> {
  const updated = await db
    .update(users)
    .set({
      passwordHash,
      status: 'active',
      inviteTokenHash: null,
      inviteExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(users.inviteTokenHash, hashToken(token)),
        eq(users.status, 'invited'),
        isNull(users.deletedAt),
        gt(users.inviteExpiresAt, new Date()),
      ),
    )
    .returning({ id: users.id })

  return updated[0]?.id ?? null
}

/**
 * Clear invitations that have timed out.
 *
 * Not a security measure — `findPendingInvite()` already refuses them. This is hygiene:
 * `invite_token_hash` carries a unique index, and a hash that will never be used again
 * does not need to occupy it. Worth scheduling alongside `pruneDeadSessions()`.
 */
export async function purgeExpiredInvites(): Promise<number> {
  const cleared = await db
    .update(users)
    .set({ inviteTokenHash: null, inviteExpiresAt: null })
    .where(and(sql`${users.inviteTokenHash} is not null`, sql`${users.inviteExpiresAt} < now()`))
    .returning({ id: users.id })

  return cleared.length
}
