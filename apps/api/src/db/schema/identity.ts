import { sql } from 'drizzle-orm'
import { index, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import { primaryId, timestamps, timestamptz } from '#db/columns'

/**
 * Identity: who is allowed in, and the sessions that prove it.
 */

/**
 * `invited` means the account exists but has never had a password set. It is kept separate
 * from `disabled` because the two mean different things to whoever is reading the user
 * list: one is waiting, the other was switched off on purpose.
 */
export const userStatus = pgEnum('user_status', ['invited', 'active', 'disabled'])

export type UserStatus = (typeof userStatus.enumValues)[number]

export const users = pgTable(
  'users',
  {
    id: primaryId(),

    email: text('email').notNull(),
    name: text('name').notNull(),

    /** Argon2id — see `src/lib/password.ts`. NULL for as long as the status is `invited`. */
    passwordHash: text('password_hash'),

    /**
     * A pending invitation, stored as the SHA-256 of the `inv_…` token — the same treatment
     * the session token gets: the value that goes to the person exists exactly once, and
     * what we keep is a hash of it.
     *
     * It lives here rather than in a `user_invites` table of its own because a user may
     * only ever have one outstanding invitation: when an admin re-sends, the previous one
     * must die. A separate table turns that rule into something every query has to
     * remember; a single column makes it impossible to break.
     */
    inviteTokenHash: text('invite_token_hash'),
    inviteExpiresAt: timestamptz('invite_expires_at'),

    status: userStatus('status').notNull().default('invited'),
    lastLoginAt: timestamptz('last_login_at'),

    /** Soft delete: someone who leaves must still be referable by old audit entries. */
    deletedAt: timestamptz('deleted_at'),

    ...timestamps(),
  },
  (table) => [
    /** Compared through `lower()`, so "Ada@…" and "ada@…" are not two different people. */
    uniqueIndex('users_email_key').on(sql`lower(${table.email})`),
    index('users_status_idx').on(table.status),

    /**
     * Partial, because the column is NULL for everyone who is not currently invited and
     * there is no point indexing all of them. Unique, because the invitation link is
     * looked up by this hash alone.
     */
    uniqueIndex('users_invite_token_key')
      .on(table.inviteTokenHash)
      .where(sql`${table.inviteTokenHash} IS NOT NULL`),
  ],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * The SHA-256 of the cookie value, **not** the value. A session token is a live
     * credential: if a database dump leaks, a hash means its contents cannot be replayed
     * straight back into a login. SHA-256 is enough here — unlike for a password — because
     * the token is 256 bits of randomness, so there is no dictionary to run against it.
     */
    tokenHash: text('token_hash').notNull(),

    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),

    expiresAt: timestamptz('expires_at').notNull(),
    /** Set on sign-out, and when a session is revoked from a device list. */
    revokedAt: timestamptz('revoked_at'),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),

    ...timestamps(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_key').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
    /** For the job that sweeps expired rows. */
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
)

export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
