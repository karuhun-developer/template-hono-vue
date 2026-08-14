import { ApiError, notFound, unauthorized } from '#lib/errors'
import { hashPassword, needsRehash, verifyDummyPassword, verifyPassword } from '#lib/password'
import type { ClientInfo } from '#lib/request-info'
import { looksLikeToken } from '#lib/token'
import { findUserByEmail, markUserLoggedIn } from '#platform/auth.repo'
import { acceptInvite, findPendingInvite } from '#platform/invite.repo'
import { createSession, revokeSessionByToken, type IssuedSession } from '#platform/session.repo'

/**
 * The sign-in rules.
 *
 * Two things are held to strictly throughout this file:
 *
 * 1. **One failure message for every cause.** Unknown email, wrong password, an account
 *    still sitting on an invitation — all of them answer with the same sentence. A message
 *    that distinguishes between them turns the sign-in endpoint into an email verifier.
 * 2. **Comparable response times.** Every failing path still runs one argon2 verification,
 *    through `verifyDummyPassword()`. Without it, "no such email" comes back ~25 ms sooner
 *    than "wrong password", and that gap is measurable from the outside.
 *
 * There is one deliberate exception at the end: an account that has **already proved its
 * password** but is disabled gets a clear message. Nothing leaks at that point — the
 * person demonstrably owns the account — and answering "wrong email or password" to
 * someone whose access was just revoked only ends in a support call.
 */

const LOGIN_FAILED = 'Wrong email or password.'

export type Principal = {
  id: string
  email: string
  name: string
}

export type LoginResult = {
  principal: Principal
  session: IssuedSession
}

export type LoginInput = {
  email: string
  password: string
}

export async function loginUser(input: LoginInput, client: ClientInfo): Promise<LoginResult> {
  const user = await findUserByEmail(input.email)
  // A null `passwordHash` means an invited user who has never set one. Treated exactly
  // like a user who does not exist; their way in is the invitation link, not this.
  if (!user || user.passwordHash === null) return failLogin(input.password)

  const ok = await verifyPassword(user.passwordHash, input.password)
  if (!ok) return failLogin(input.password)

  assertAccountUsable(user.status)

  await markUserLoggedIn(user.id, await rehashIfStale(user.passwordHash, input.password))

  const session = await createSession(user.id, client)

  return {
    session,
    principal: { id: user.id, email: user.email, name: user.name },
  }
}

/**
 * Signing out always "succeeds".
 *
 * A token that does not exist, has expired, or was already revoked still gets a 200 —
 * otherwise this endpoint becomes a way to test whether a token was ever valid. The cookie
 * is cleared by the route regardless of what happened in the database.
 */
export async function logout(token: string | null): Promise<void> {
  if (!token) return
  await revokeSessionByToken(token)
}

/**
 * Burn the time of one argon2 verification, then throw the uniform failure.
 *
 * Its return type is `never`, so callers can write `return failLogin(...)` and TypeScript
 * still knows that path never produces a `LoginResult`.
 */
async function failLogin(attempted: string): Promise<never> {
  await verifyDummyPassword(attempted)
  throw unauthorized(LOGIN_FAILED)
}

function assertAccountUsable(status: 'invited' | 'active' | 'disabled'): void {
  if (status === 'active') return
  throw new ApiError(
    'forbidden',
    status === 'invited'
      ? 'Your invitation has not been accepted yet. Open the invitation link to set a password.'
      : 'This account has been disabled. Ask an administrator to re-enable it.',
  )
}

/**
 * If the hash was made with older parameters, recompute it while the plaintext is here.
 *
 * Returns `null` when nothing needs to change, so the caller can pass the result straight
 * through to the repository with no branching. A failure here must **not** fail the
 * sign-in: the password has already been proved correct, and a failed rehash is no reason
 * to keep somebody out.
 */
async function rehashIfStale(currentHash: string, plain: string): Promise<string | null> {
  if (!needsRehash(currentHash)) return null
  try {
    return await hashPassword(plain)
  } catch {
    return null
  }
}

// --- Invitations ------------------------------------------------------------

/**
 * The part of an invitation that can be shown before it is accepted.
 *
 * Displayed so that the person can see which account they are setting a password for.
 * Invitation links get forwarded through chat, and a page that says nothing but "Set your
 * password" helps nobody.
 */
export type InvitePreview = {
  email: string
  name: string
  expiresAt: Date
}

const INVITE_INVALID = 'This invitation link is no longer valid. Ask for a new one.'

export async function previewInvite(token: string): Promise<InvitePreview> {
  const invite = looksLikeToken(token, 'invite') ? await findPendingInvite(token) : null
  if (!invite) throw notFound(INVITE_INVALID)

  return { email: invite.email, name: invite.name, expiresAt: invite.expiresAt }
}

/**
 * Accept an invitation: set the first password, activate the account, sign straight in.
 *
 * A session is issued immediately because the person has just proved two things at once —
 * they hold the link, and they chose the password. Making them retype an email and a
 * password they picked three seconds ago adds no security; it only adds people who mistype
 * something and call an administrator.
 */
export async function acceptInvitation(
  input: { token: string; password: string },
  client: ClientInfo,
): Promise<LoginResult> {
  if (!looksLikeToken(input.token, 'invite')) throw notFound(INVITE_INVALID)

  const invite = await findPendingInvite(input.token)
  if (!invite) throw notFound(INVITE_INVALID)

  const userId = await acceptInvite(input.token, await hashPassword(input.password))
  if (!userId) throw notFound(INVITE_INVALID)

  const session = await createSession(userId, client)

  return {
    session,
    principal: { id: userId, email: invite.email, name: invite.name },
  }
}
