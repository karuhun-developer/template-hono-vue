import { and, eq, isNull, lt, sql } from 'drizzle-orm'

import { db } from '#db/client'
import { sessions, users } from '#db/schema'
import { env } from '#env'
import { hashToken, issueToken } from '#lib/token'

/**
 * Reads and writes against the `sessions` table.
 *
 * Everything under `src/platform/**` is a repository that runs **before there is an
 * authenticated context** — a session lookup is what establishes that context, so it
 * cannot itself depend on one. Keeping those queries in one directory is what makes the
 * rule in docs/guides/add-multi-tenancy.md enforceable: when you add tenant scoping, this
 * is the only place allowed to query without a tenant filter, and the guide ships an
 * ESLint rule that says so.
 */

export type SessionRequestInfo = {
  userAgent: string | null
  ipAddress: string | null
}

export type IssuedSession = {
  id: string
  /** The value that goes into the cookie. It exists here, once. */
  token: string
  expiresAt: Date
}

function expiryFromNow(): Date {
  return new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
}

export async function createSession(
  userId: string,
  info: SessionRequestInfo,
): Promise<IssuedSession> {
  const { token, tokenHash } = issueToken('session')
  const expiresAt = expiryFromNow()

  const [created] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash,
      userAgent: info.userAgent,
      ipAddress: info.ipAddress,
      expiresAt,
    })
    .returning({ id: sessions.id })

  if (!created) throw new Error('failed to create the session')

  return { id: created.id, token, expiresAt }
}

/** A verified session together with the person it belongs to. */
export type LiveSession = {
  id: string
  expiresAt: Date
  lastSeenAt: Date
  user: {
    id: string
    email: string
    name: string
  }
}

/**
 * Find the session a cookie value refers to, if it is **still usable**.
 *
 * Every liveness condition is tested in SQL rather than in JavaScript: not expired, not
 * revoked, and the owner still active. Filtering in the application would leave a window
 * in which a row that ought to be dead is read and used — and disabling someone who was
 * just let go has to take effect on their next request, not in thirty days.
 */
export async function findLiveSession(token: string): Promise<LiveSession | null> {
  const [row] = await db
    .select({
      id: sessions.id,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      userEmail: users.email,
      userName: users.name,
    })
    .from(sessions)
    .innerJoin(
      users,
      and(eq(users.id, sessions.userId), eq(users.status, 'active'), isNull(users.deletedAt)),
    )
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`,
      ),
    )
    .limit(1)

  if (!row) return null

  return {
    id: row.id,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    user: { id: row.userId, email: row.userEmail, name: row.userName },
  }
}

/**
 * Revoke a session by its cookie value. Safe to call for a token that does not exist —
 * signing out must not reveal that a token was ever valid.
 */
export async function revokeSessionByToken(token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
}

/** Used when a user is disabled or changes their password: every device signs out. */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
}

/**
 * Note that a session was just used.
 *
 * Deliberately not called on every request: one `UPDATE` per request against a table read
 * on every request is the easiest way to make an application feel heavy under load. The
 * caller — the session middleware — holds off until the gap crosses a threshold.
 */
export async function touchSession(sessionId: string): Promise<void> {
  await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, sessionId))
}

/**
 * Drop sessions that are of no further use. Worth scheduling as a daily job.
 *
 * Revoked sessions are removed once they pass their expiry rather than immediately — a
 * "devices that have signed in" list on a security page is only useful while the rows are
 * still there to look at.
 */
export async function pruneDeadSessions(): Promise<number> {
  const removed = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id })

  return removed.length
}
