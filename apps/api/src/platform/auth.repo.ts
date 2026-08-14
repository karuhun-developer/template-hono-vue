import { eq, isNull, and, sql } from 'drizzle-orm'

import { db } from '#db/client'
import { users } from '#db/schema'

/**
 * Identity lookups on the sign-in path.
 *
 * See the note in `session.repo.ts` for why these live under `src/platform/**`: they run
 * before any authenticated context exists. The rule for this directory is that everything
 * in it takes **self-limiting input only** — an email being authenticated, a token hash,
 * an id that came out of a session — and never a raw filter from a client.
 */

export type UserCredentials = {
  id: string
  email: string
  name: string
  passwordHash: string | null
  status: (typeof users.status.enumValues)[number]
}

/**
 * Find a user by email.
 *
 * Matched through `lower()` so it agrees with the unique index. If it did not, "Ada@…"
 * could pass as a different person from "ada@…" even though the database forbids it, and
 * the result would not be a duplicate but a sign-in that fails for no visible reason.
 *
 * A `disabled` user is **still returned**. Filtering them out is the service's job, after
 * the password has been verified: filter here, and someone who mistyped their password
 * gets a measurably different response time from someone whose account was switched off.
 */
export async function findUserByEmail(email: string): Promise<UserCredentials | null> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(and(sql`lower(${users.email}) = lower(${email})`, isNull(users.deletedAt)))
    .limit(1)

  return user ?? null
}

/** Called after a successful sign-in. A failure here must not fail the sign-in. */
export async function markUserLoggedIn(userId: string, hash: string | null): Promise<void> {
  await db
    .update(users)
    .set({
      lastLoginAt: new Date(),
      updatedAt: new Date(),
      ...(hash === null ? {} : { passwordHash: hash }),
    })
    .where(eq(users.id, userId))
}
