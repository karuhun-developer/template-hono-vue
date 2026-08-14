import { z } from 'zod'

/**
 * The shape of auth requests.
 *
 * Validation here is deliberately **lax about passwords**: a minimum length is only
 * enforced when a password is being *set*, never when it is being used to sign in.
 * Rejecting a sign-in because the password is too short tells an attacker what the length
 * rule is and saves nobody — an old short password still has to get in so it can be
 * changed.
 */

export const email = z
  .string()
  .trim()
  .min(1, 'Email is required.')
  .max(320)
  .toLowerCase()
  .pipe(z.email('That does not look like an email address.'))

const password = z.string().min(1, 'Password is required.').max(512)

export const loginBody = z.object({ email, password })

export type LoginBody = z.infer<typeof loginBody>

/** Used when an invited user sets their first password. */
export const newPassword = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(512, 'That password is too long.')

/**
 * The invitation token is only shape-checked here — whether it is valid is decided by the
 * hash lookup in the database, not by a regular expression. This layer filters out
 * rubbish, so that a random string from an automated scanner does not become a query.
 */
export const inviteToken = z.string().trim().min(1, 'The invitation token is required.').max(128)

export const acceptInviteBody = z.object({ token: inviteToken, password: newPassword })

export type AcceptInviteBody = z.infer<typeof acceptInviteBody>
