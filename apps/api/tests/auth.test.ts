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

let inviteToken: string

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
})

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

describe('sessions', () => {
  it('stores the hash of the token, never the token', async () => {
    const cookie = await login(app, OWNER)

    const rows = await db.select({ tokenHash: sessions.tokenHash }).from(sessions)
    expect(rows.every((row) => row.tokenHash !== cookie)).toBe(true)
  })
})
