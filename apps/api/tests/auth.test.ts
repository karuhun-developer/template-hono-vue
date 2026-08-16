import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { app } from '#app'
import { closeDatabase, db } from '#db/client'
import { sessions, users } from '#db/schema'
import { issueToken } from '#lib/token'
import { findLiveSession } from '#platform/session.repo'

import {
  cleanFixtures,
  createUser,
  emailFor,
  ensureCatalog,
  lastMailTo,
  login,
  request,
  sessionCookie,
  TEST_PASSWORD,
} from './support/world'

/**
 * Signing in, signing out, and what a session is worth — against a real Postgres.
 *
 * The properties tested here are the ones that go wrong silently: a token that also ends
 * up in the response body, a cookie that forgets `HttpOnly`, a login failure whose message
 * differs depending on whether the account exists.
 */

const TAG = 'auth'
const OWNER = emailFor(TAG, 'owner')
const DISABLED = emailFor(TAG, 'disabled')
const INVITED = emailFor(TAG, 'invited')
/** Never accepts its invitation, so the reset tests still have an `invited` account to ask about. */
const PENDING = emailFor(TAG, 'pending')
/** Asks for a reset through the public form. */
const FORGETFUL = emailFor(TAG, 'forgetful')
/** Handed a reset token directly, because the public endpoint deliberately returns none. */
const RESETTER = emailFor(TAG, 'resetter')
/** Holds a token that timed out an hour ago. */
const STALE = emailFor(TAG, 'stale')

const RESETTER_NEW_PASSWORD = 'a-brand-new-password'

let inviteToken: string
let resetToken: string
let staleToken: string

beforeAll(async () => {
  await cleanFixtures(TAG)
  await ensureCatalog()

  await createUser(OWNER, { name: 'Owner' })
  await createUser(DISABLED, { name: 'Former Colleague', status: 'disabled' })

  const invitedId = await createUser(INVITED, { name: 'New Joiner', status: 'invited' })
  const invite = issueToken('invite')
  inviteToken = invite.token

  await db
    .update(users)
    .set({
      inviteTokenHash: invite.tokenHash,
      inviteExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .where(eq(users.id, invitedId))

  await createUser(PENDING, { name: 'Still Waiting', status: 'invited' })
  await createUser(FORGETFUL, { name: 'Forgetful' })

  // Planted rather than requested: `POST /auth/forgot-password` returns no token by design,
  // so the only way a test can hold one is to write it the way the repository would.
  const resetterId = await createUser(RESETTER, { name: 'Reset Me' })
  const reset = issueToken('reset')
  resetToken = reset.token
  await db
    .update(users)
    .set({
      passwordResetTokenHash: reset.tokenHash,
      passwordResetExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .where(eq(users.id, resetterId))

  const staleId = await createUser(STALE, { name: 'Too Late' })
  const stale = issueToken('reset')
  staleToken = stale.token
  await db
    .update(users)
    .set({
      passwordResetTokenHash: stale.tokenHash,
      passwordResetExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
    })
    .where(eq(users.id, staleId))
})

/** The two columns the whole flow turns on, read straight from the row. */
async function resetColumns(
  email: string,
): Promise<{ hash: string | null; expiresAt: Date | null }> {
  const [row] = await db
    .select({ hash: users.passwordResetTokenHash, expiresAt: users.passwordResetExpiresAt })
    .from(users)
    .where(eq(users.email, email))

  if (!row) throw new Error(`no user row for ${email}`)
  return row
}

afterAll(async () => {
  await cleanFixtures(TAG)
  await closeDatabase()
})

describe('POST /auth/login', () => {
  it('returns the profile and sets a session cookie', async () => {
    const res = await request(app, '/auth/login', {
      method: 'POST',
      body: { email: OWNER, password: TEST_PASSWORD },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ user: { email: OWNER, name: 'Owner' } })
  })

  it('never puts the session token in the response body', async () => {
    const res = await request(app, '/auth/login', {
      method: 'POST',
      body: { email: OWNER, password: TEST_PASSWORD },
    })
    const token = sessionCookie(res)
    const body = await res.text()

    expect(token).toBeTruthy()
    // If the token were in the body too, a client would keep its own copy and `httpOnly`
    // would be worth nothing.
    expect(body).not.toContain(token)
  })

  it('sets the cookie HttpOnly, SameSite=Lax, on the root path', async () => {
    const res = await request(app, '/auth/login', {
      method: 'POST',
      body: { email: OWNER, password: TEST_PASSWORD },
    })
    const raw = res.headers.get('set-cookie') ?? ''

    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('SameSite=Lax')
    expect(raw).toContain('Path=/')
  })

  it('answers a wrong password and an unknown address identically', async () => {
    const wrongPassword = await request(app, '/auth/login', {
      method: 'POST',
      body: { email: OWNER, password: 'not-the-password' },
    })
    const noSuchUser = await request(app, '/auth/login', {
      method: 'POST',
      body: { email: emailFor(TAG, 'ghost'), password: TEST_PASSWORD },
    })

    expect(wrongPassword.status).toBe(401)
    expect(noSuchUser.status).toBe(401)
    // Any difference here is an endpoint that confirms whether an address has an account.
    expect(await wrongPassword.json()).toEqual(await noSuchUser.json())
  })

  /**
   * The one deliberate exception to the uniform message: this account has just proved it
   * owns the password, so naming the reason leaks nothing — and answering "wrong email or
   * password" to somebody whose access was revoked only ends in a support call.
   */
  it('tells a disabled account why it was refused, and issues no session', async () => {
    const res = await request(app, '/auth/login', {
      method: 'POST',
      body: { email: DISABLED, password: TEST_PASSWORD },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } })
    expect(sessionCookie(res)).toBeNull()
  })

  it('refuses an invited account that has never set a password', async () => {
    const res = await request(app, '/auth/login', {
      method: 'POST',
      body: { email: INVITED, password: TEST_PASSWORD },
    })

    expect(res.status).toBe(401)
  })
})

describe('GET /auth/me', () => {
  it('is 401 without a session', async () => {
    const res = await request(app, '/auth/me')

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } })
  })

  it('returns the user and their permissions', async () => {
    const cookie = await login(app, OWNER)
    const res = await request(app, '/auth/me', { cookie })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ user: { email: OWNER }, permissions: [] })
  })

  it('ignores a token that never existed', async () => {
    const res = await request(app, '/auth/me', { cookie: issueToken('session').token })

    expect(res.status).toBe(401)
  })
})

describe('POST /auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const cookie = await login(app, OWNER)
    const res = await request(app, '/auth/logout', { method: 'POST', cookie })

    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toBeNull()
    // Revoked in the database, not only in the browser: a copied cookie must die too.
    expect(await findLiveSession(cookie)).toBeNull()
  })

  it('is not an error when there is no session to end', async () => {
    const res = await request(app, '/auth/logout', { method: 'POST' })

    expect(res.status).toBe(200)
  })
})

describe('invitations', () => {
  it('previews an invitation without a session', async () => {
    const res = await request(app, `/auth/invitation/${inviteToken}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ invitation: { email: INVITED, name: 'New Joiner' } })
  })

  it('refuses a token that does not exist', async () => {
    const res = await request(app, `/auth/invitation/${issueToken('invite').token}`)

    expect(res.status).toBe(404)
  })

  it('accepts the invitation, sets the password and signs the person straight in', async () => {
    const res = await request(app, '/auth/invitation/accept', {
      method: 'POST',
      body: { token: inviteToken, password: 'a-fresh-password' },
    })

    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toBeTruthy()

    const [row] = await db
      .select({ status: users.status, inviteTokenHash: users.inviteTokenHash })
      .from(users)
      .where(eq(users.email, INVITED))

    expect(row).toMatchObject({ status: 'active', inviteTokenHash: null })
  })

  it('cannot be accepted twice', async () => {
    const res = await request(app, '/auth/invitation/accept', {
      method: 'POST',
      body: { token: inviteToken, password: 'another-password' },
    })

    expect(res.status).toBe(404)
  })

  it('rejects a password below the minimum length', async () => {
    const res = await request(app, '/auth/invitation/accept', {
      method: 'POST',
      body: { token: issueToken('invite').token, password: 'short' },
    })

    expect(res.status).toBe(400)
  })
})

/**
 * The rule this endpoint exists to keep is that **nothing about the outcome escapes**, so
 * almost every assertion here is on the `users` row rather than on the response. Asserting
 * on the body could only ever prove that two identical answers are identical.
 */
describe('POST /auth/forgot-password', () => {
  it('issues a token for a live account', async () => {
    const res = await request(app, '/auth/forgot-password', {
      method: 'POST',
      body: { email: FORGETFUL },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect((await resetColumns(FORGETFUL)).hash).not.toBeNull()
  })

  /**
   * The link goes to the person, and only to the person. The response cannot carry it —
   * that would hand it to whoever asked — so the mail is the entire channel, and this is
   * the assertion that it exists.
   */
  it('sends the link by email, and stores that copy with the token redacted', async () => {
    const message = await lastMailTo(FORGETFUL)

    expect(message?.template).toBe('password-reset')
    expect(message?.toEmail).toBe(FORGETFUL)
    // The stored body is what the Mail log page shows. A live reset link in it would make
    // `mail.read` a way of taking accounts over.
    expect(message?.textBody).toContain('[redacted]')
    expect(message?.textBody).not.toMatch(/rst_[\w-]+/)
  })

  it('answers an unknown address exactly as it answered a real one', async () => {
    const real = await request(app, '/auth/forgot-password', {
      method: 'POST',
      body: { email: FORGETFUL },
    })
    const ghost = await request(app, '/auth/forgot-password', {
      method: 'POST',
      body: { email: emailFor(TAG, 'nobody') },
    })

    expect(ghost.status).toBe(real.status)
    expect(await ghost.json()).toEqual(await real.json())
  })

  it('writes no token for an invited account, which has never had a password to forget', async () => {
    const res = await request(app, '/auth/forgot-password', {
      method: 'POST',
      body: { email: PENDING },
    })

    expect(res.status).toBe(200)
    expect((await resetColumns(PENDING)).hash).toBeNull()
    // No token, and therefore no email either — the mail is queued in the same transaction
    // that issued one, so there is no way to have the second without the first.
    expect(await lastMailTo(PENDING)).toBeNull()
  })

  /** Otherwise "switch this person off" is undone by a form anybody can post to. */
  it('writes no token for a disabled account', async () => {
    const res = await request(app, '/auth/forgot-password', {
      method: 'POST',
      body: { email: DISABLED },
    })

    expect(res.status).toBe(200)
    expect((await resetColumns(DISABLED)).hash).toBeNull()
    expect(await lastMailTo(DISABLED)).toBeNull()
  })

  /**
   * A second ask inside the cooldown leaves the first link alone and still answers `200`.
   * If it rotated the token, the mail already on its way would be dead on arrival; if it
   * answered differently, the cooldown itself would confirm the address exists.
   */
  it('leaves the outstanding token alone inside the cooldown, and says nothing about it', async () => {
    const before = await resetColumns(FORGETFUL)

    const res = await request(app, '/auth/forgot-password', {
      method: 'POST',
      body: { email: FORGETFUL },
    })

    expect(res.status).toBe(200)
    expect((await resetColumns(FORGETFUL)).hash).toBe(before.hash)
  })

  it('rejects something that is not an email address', async () => {
    const res = await request(app, '/auth/forgot-password', {
      method: 'POST',
      body: { email: 'not-an-address' },
    })

    expect(res.status).toBe(400)
  })
})

describe('password resets', () => {
  it('previews the account a link belongs to', async () => {
    const res = await request(app, `/auth/password-reset/${resetToken}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ reset: { email: RESETTER } })
  })

  it('refuses a token that does not exist', async () => {
    const res = await request(app, `/auth/password-reset/${issueToken('reset').token}`)

    expect(res.status).toBe(404)
  })

  /**
   * Rubbish is rejected by `looksLikeToken()` before it becomes a query — this endpoint is
   * public, and an automated scanner should not be worth a round trip each.
   */
  it('refuses a malformed token', async () => {
    const res = await request(app, '/auth/password-reset/not-a-token')

    expect(res.status).toBe(404)
  })

  /** An invitation link offered to the reset door: right shape, wrong family. */
  it('refuses an invitation token', async () => {
    const res = await request(app, `/auth/password-reset/${issueToken('invite').token}`)

    expect(res.status).toBe(404)
  })

  it('sets the new password, kills every other session, and signs the person in', async () => {
    const oldCookie = await login(app, RESETTER)
    expect((await request(app, '/auth/me', { cookie: oldCookie })).status).toBe(200)

    const res = await request(app, '/auth/reset-password', {
      method: 'POST',
      body: { token: resetToken, password: RESETTER_NEW_PASSWORD },
    })

    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toBeTruthy()

    // "I forgot my password" and "somebody else has my password" arrive through the same
    // door, and only one of them is safe to leave signed in elsewhere.
    expect((await request(app, '/auth/me', { cookie: oldCookie })).status).toBe(401)

    expect((await resetColumns(RESETTER)).hash).toBeNull()
  })

  it('leaves the old password dead and the new one working', async () => {
    const old = await request(app, '/auth/login', {
      method: 'POST',
      body: { email: RESETTER, password: TEST_PASSWORD },
    })

    expect(old.status).toBe(401)
    await expect(login(app, RESETTER, RESETTER_NEW_PASSWORD)).resolves.toBeTruthy()
  })

  /** The hash is in the `WHERE`, so a double-clicked button cannot apply twice. */
  it('cannot be used a second time', async () => {
    const res = await request(app, '/auth/reset-password', {
      method: 'POST',
      body: { token: resetToken, password: 'yet-another-password' },
    })

    expect(res.status).toBe(404)
  })

  it('refuses a token that has expired', async () => {
    const res = await request(app, '/auth/reset-password', {
      method: 'POST',
      body: { token: staleToken, password: 'a-password-too-late' },
    })

    expect(res.status).toBe(404)
    // Still there, untouched: expiry is refused by the query, not by clearing the row.
    expect((await resetColumns(STALE)).hash).not.toBeNull()
  })

  it('rejects a password below the minimum length', async () => {
    const res = await request(app, '/auth/reset-password', {
      method: 'POST',
      body: { token: issueToken('reset').token, password: 'short' },
    })

    expect(res.status).toBe(400)
  })
})

describe('sessions', () => {
  it('stores the hash of the token, never the token', async () => {
    const cookie = await login(app, OWNER)

    const rows = await db.select({ tokenHash: sessions.tokenHash }).from(sessions)
    expect(rows.every((row) => row.tokenHash !== cookie)).toBe(true)
  })
})
