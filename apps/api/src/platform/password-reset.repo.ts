import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'

import { db, type DatabaseHandle } from '#db/client'
import { users } from '#db/schema'
import { env } from '#env'
import { hashToken, issueToken } from '#lib/token'

/**
 * Password reset lookups — **before** there is a session, like everything else here.
 *
 * Whoever follows a reset link cannot sign in; that is the entire reason they are asking.
 * So this sits beside the invitation queries, takes only self-limiting input — a token hash
 * or a user id that came from a verified lookup — and never a filter from a client.
 *
 * Every liveness condition is in SQL: the token matches, it has not expired, the account is
 * `active` and not deleted. `active` matters more than it looks. An **invited** account's
 * way in is its invitation, and a **disabled** one must not be able to reset its way back
 * in — if either could, "switch this person off" would be undone by a form anybody can post
 * to.
 */

/**
 * How long a caller must wait before a second link is issued to the same address.
 *
 * Without it `POST /auth/forgot-password` is an email cannon pointed at anybody whose
 * address is known. A minute is short enough that somebody who genuinely lost the first
 * mail is not stuck, and long enough that a script achieves nothing.
 */
export const RESET_COOLDOWN_SECONDS = 60

export type IssuedReset = {
  /** The value handed to the person. It exists once, and only its hash is stored. */
  token: string
  expiresAt: Date
}

export type PendingReset = {
  userId: string
  email: string
  name: string
  expiresAt: Date
}

/**
 * Start a reset, replacing any link already outstanding for that account.
 *
 * Returns `null` when nothing was written — the account is not one that may reset (invited,
 * disabled, deleted, gone), or the cooldown has not elapsed. The caller cannot tell those
 * apart on purpose: the public endpoint answers identically to all of them.
 *
 * The cooldown is a **condition on the row**, not a read followed by a write, so two
 * requests arriving together cannot both pass it. There is deliberately no
 * `password_reset_issued_at` column to compare against — a token issued `n` seconds ago
 * expires `ttl - n` from now, so "issued within the cooldown" is exactly "expires later than
 * `now + ttl - cooldown`". One less column, and one less pair of values that can disagree.
 */
export async function issueReset(
  handle: DatabaseHandle,
  userId: string,
  options: { cooldownSeconds?: number } = {},
): Promise<IssuedReset | null> {
  const { token, tokenHash } = issueToken('reset')
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60 * 1000)
  const cooldownSeconds = options.cooldownSeconds ?? 0
  const cooldownFloor = new Date(expiresAt.getTime() - cooldownSeconds * 1000)

  const updated = await handle
    .update(users)
    .set({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(users.id, userId),
        eq(users.status, 'active'),
        isNull(users.deletedAt),
        cooldownSeconds > 0
          ? or(
              isNull(users.passwordResetExpiresAt),
              lt(users.passwordResetExpiresAt, cooldownFloor),
            )
          : undefined,
      ),
    )
    .returning({ id: users.id })

  return updated[0] ? { token, expiresAt } : null
}

/**
 * A reset that can still be used, with enough of the account to render a page.
 *
 * The email is shown so that somebody holding a forwarded link can see which account they
 * are about to set a password for — the same courtesy `findPendingInvite()` extends, and
 * nothing is revealed that the holder of the token does not already control.
 */
export async function findPendingReset(token: string): Promise<PendingReset | null> {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      expiresAt: users.passwordResetExpiresAt,
    })
    .from(users)
    .where(
      and(
        eq(users.passwordResetTokenHash, hashToken(token)),
        eq(users.status, 'active'),
        isNull(users.deletedAt),
        gt(users.passwordResetExpiresAt, new Date()),
      ),
    )
    .limit(1)

  if (!row?.expiresAt) return null

  return { ...row, expiresAt: row.expiresAt }
}

/**
 * Trade the token for a password. Returns `null` when nothing changed.
 *
 * The token hash is in the `WHERE`, exactly as in `acceptInvite()`, so a double-clicked
 * button cannot apply twice: the second request matches zero rows and is answered like an
 * expired link, rather than overwriting the password the first one just set.
 */
export async function consumeReset(token: string, passwordHash: string): Promise<string | null> {
  const updated = await db
    .update(users)
    .set({
      passwordHash,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(users.passwordResetTokenHash, hashToken(token)),
        eq(users.status, 'active'),
        isNull(users.deletedAt),
        gt(users.passwordResetExpiresAt, new Date()),
      ),
    )
    .returning({ id: users.id })

  return updated[0]?.id ?? null
}

/**
 * Clear resets that have timed out.
 *
 * Hygiene, not security — `findPendingReset()` already refuses them. The hash occupies a
 * unique index it will never be looked up in again. Worth scheduling next to
 * `purgeExpiredInvites()`.
 */
export async function purgeExpiredResets(): Promise<number> {
  const cleared = await db
    .update(users)
    .set({ passwordResetTokenHash: null, passwordResetExpiresAt: null })
    .where(
      and(
        sql`${users.passwordResetTokenHash} is not null`,
        sql`${users.passwordResetExpiresAt} < now()`,
      ),
    )
    .returning({ id: users.id })

  return cleared.length
}
