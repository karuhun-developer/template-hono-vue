import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Opaque tokens for sessions and invitations.
 *
 * Not JWTs. A JWT has to be trustworthy without touching the database, and the price of
 * that property is a token that stays valid until it expires — revocation only takes
 * effect at expiry, or needs a deny-list, which is a database lookup with extra steps.
 * Here, "disable this account and its sessions die now" is a real operational
 * requirement, so we pay for the lookup up front: the token is a random number, and the
 * authority lives in a database row.
 *
 * What gets stored is the **SHA-256 hash**, not the token. If a database dump leaks, its
 * contents cannot be replayed into a session. Unsalted SHA-256 is enough here — unlike
 * for a password — because the token is 256 bits of full-entropy randomness, so there is
 * no dictionary to run against it.
 */

/**
 * The prefix is part of the token so that one leaked into a log or a repository is
 * recognisable on sight, and so secret scanners have a pattern to match.
 */
export const TOKEN_PREFIX = {
  session: 'sess',
  /** User invitations. Short-lived and single-use — see `modules/users`. */
  invite: 'inv',
} as const

export type TokenKind = keyof typeof TOKEN_PREFIX

/** 32 bytes = 256 bits. Guessing one takes more attempts than there is time. */
const TOKEN_BYTES = 32

export type IssuedToken = {
  /** The full value handed to the client. It exists once and is never stored. */
  token: string
  /** What goes into the `token_hash` column. */
  tokenHash: string
}

export function issueToken(kind: TokenKind): IssuedToken {
  const token = `${TOKEN_PREFIX[kind]}_${randomBytes(TOKEN_BYTES).toString('base64url')}`
  return { token, tokenHash: hashToken(token) }
}

/** SHA-256 hex of the whole token, prefix included. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Reject malformed tokens **before** touching the database.
 *
 * A stale cookie from an older deployment, or a random string from an automated scanner,
 * does not deserve a query each.
 */
export function looksLikeToken(value: string, kind: TokenKind): boolean {
  const prefix = `${TOKEN_PREFIX[kind]}_`
  if (!value.startsWith(prefix)) return false

  const body = value.slice(prefix.length)
  // base64url of 32 bytes is always 43 characters with no padding.
  return body.length === 43 && /^[A-Za-z0-9_-]+$/.test(body)
}

/**
 * Compare two secrets without leaking how far they matched through timing.
 *
 * For things like webhook signatures — not for session tokens, which are found through a
 * hash index, and Postgres offers no constant-time comparison.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // `timingSafeEqual` throws on a length mismatch, and length is not the secret.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
