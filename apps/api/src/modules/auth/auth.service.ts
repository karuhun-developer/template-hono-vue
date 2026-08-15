import { db } from '#db/client'
import { isProduction } from '#env'
import { ApiError, notFound, unauthorized } from '#lib/errors'
import { logger } from '#lib/logger'
import { hashPassword, needsRehash, verifyDummyPassword, verifyPassword } from '#lib/password'
import type { ClientInfo } from '#lib/request-info'
import { looksLikeToken } from '#lib/token'
import { recordAudit, type AuditActor } from '#modules/audit/audit.repo'
import { findUserByEmail, markUserLoggedIn } from '#platform/auth.repo'
import { acceptInvite, findPendingInvite } from '#platform/invite.repo'
import {
  consumeReset,
  findPendingReset,
  issueReset,
  RESET_COOLDOWN_SECONDS,
} from '#platform/password-reset.repo'
import {
  createSession,
  revokeAllSessionsForUser,
  revokeSessionByToken,
  type IssuedSession,
} from '#platform/session.repo'

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

// --- Password resets --------------------------------------------------------

const RESET_INVALID = 'This password reset link is no longer valid. Ask for a new one.'

/**
 * What a reset link can show before the new password is chosen. The same shape and the same
 * reasoning as `InvitePreview`.
 */
export type ResetPreview = {
  email: string
  expiresAt: Date
}

/**
 * Ask for a reset link.
 *
 * **Nothing about the outcome escapes.** This resolves `void` on every path and the route
 * always answers the same `200`, because the alternative is an endpoint that tells anybody
 * who asks whether an address has an account here — the exact thing `loginUser()` goes to
 * such lengths to avoid two hundred lines above.
 *
 * The consequences of that rule are worth spelling out, because each looks like an omission:
 *
 * - An unknown, invited, disabled or deleted address does the same visible work and returns.
 *   The status filtering lives in `issueReset()`'s `WHERE`, so this function cannot
 *   accidentally branch on it.
 * - The **cooldown returns the same answer** as a link that was issued. A second `200` that
 *   quietly sent nothing is the point.
 * - The audit entry is written **only when a token was really issued**. An entry for an
 *   address that does not exist would turn the audit log into the enumeration oracle the
 *   endpoint refuses to be — and it is read by exactly the people who could then use it.
 *
 * There is deliberately no dummy argon2 pass here, unlike on the sign-in path. This does no
 * hashing on any path, so there is no timing gap to close.
 */
export async function requestPasswordReset(address: string, actor: AuditActor): Promise<void> {
  const user = await findUserByEmail(address)
  if (!user) return

  const issued = await db.transaction(async (tx) => {
    const reset = await issueReset(tx, user.id, { cooldownSeconds: RESET_COOLDOWN_SECONDS })
    if (!reset) return null

    await recordAudit(tx, actor, {
      action: 'user.password_reset_request',
      subjectType: 'users',
      subjectId: user.id,
      subjectLabel: user.email,
    })

    return reset
  })

  if (issued) announceResetLink(user.email, issued.token)
}

export async function previewPasswordReset(token: string): Promise<ResetPreview> {
  const reset = looksLikeToken(token, 'reset') ? await findPendingReset(token) : null
  if (!reset) throw notFound(RESET_INVALID)

  return { email: reset.email, expiresAt: reset.expiresAt }
}

/**
 * Set the new password, end every other session, and sign the person in.
 *
 * The revocation is the part that matters. "I forgot my password" and "I think somebody
 * else has my password" arrive through this same door, and only one of them is safe to
 * leave signed in elsewhere. It runs **before** the new session is created, or the reset
 * would sign the person out of the session it had just handed them.
 *
 * Signing them in afterwards follows `acceptInvitation()`: they have just proved they hold
 * the link and chose the password, so a sign-in form three seconds later adds no security
 * and does add people who mistype something.
 */
export async function resetPassword(
  input: { token: string; password: string },
  client: ClientInfo,
  actor: AuditActor,
): Promise<LoginResult> {
  if (!looksLikeToken(input.token, 'reset')) throw notFound(RESET_INVALID)

  const reset = await findPendingReset(input.token)
  if (!reset) throw notFound(RESET_INVALID)

  const userId = await consumeReset(input.token, await hashPassword(input.password))
  if (!userId) throw notFound(RESET_INVALID)

  await revokeAllSessionsForUser(userId)

  await recordAudit(db, actor, {
    action: 'user.password_reset',
    subjectType: 'users',
    subjectId: userId,
    subjectLabel: reset.email,
  })

  const session = await createSession(userId, client)

  return {
    session,
    principal: { id: userId, email: reset.email, name: reset.name },
  }
}

/**
 * Put the reset link where somebody can find it, for as long as there is no mailer.
 *
 * A self-service reset is the one flow whose token can never be returned in the response —
 * that would hand the link to whoever asked for it, which is the whole attack. Until the
 * mail subsystem lands, the log is the only channel there is.
 *
 * Guarded by `isProduction` and **temporary**: a live reset link in a log aggregator is a
 * live credential. This function goes when `queueMail()` takes over the send.
 */
function announceResetLink(email: string, token: string): void {
  if (isProduction) return

  logger.info(
    { email, resetToken: token },
    'password reset requested — no mailer is configured, so the link is here',
  )
}
