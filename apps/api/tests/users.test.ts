import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { app } from '#app'
import { closeDatabase, db } from '#db/client'
import { users } from '#db/schema'

import {
  cleanFixtures,
  createRole,
  createUser,
  emailFor,
  ensureCatalog,
  login,
  request,
} from './support/world'

/**
 * User management against a real Postgres.
 *
 * The interesting cases are not "can an owner invite somebody" — they are the ways an
 * invitation could be turned into a promotion, and what happens to a session at the moment
 * its owner is switched off.
 */

const TAG = 'users'
const OWNER = emailFor(TAG, 'owner')
/** Holds `user.invite` and `user.update`, but nothing dangerous — the escalation subject. */
const RECRUITER = emailFor(TAG, 'recruiter')
const MEMBER = emailFor(TAG, 'member')

let ownerCookie: string
let recruiterCookie: string
let memberCookie: string
let memberId: string
let ownerId: string
let powerfulRoleId: string
let plainRoleId: string

beforeAll(async () => {
  await cleanFixtures(TAG)
  await ensureCatalog()

  powerfulRoleId = await createRole(TAG, 'powerful', [
    'user.read',
    'user.invite',
    'user.update',
    'user.disable',
    'role.read',
    'role.manage',
    'audit.read',
  ])
  const recruiterRoleId = await createRole(TAG, 'recruiter', [
    'user.read',
    'user.invite',
    'user.update',
  ])
  plainRoleId = await createRole(TAG, 'plain', ['user.read'])

  ownerId = await createUser(OWNER, { name: 'Owner', roleIds: [powerfulRoleId] })
  await createUser(RECRUITER, { name: 'Recruiter', roleIds: [recruiterRoleId] })
  memberId = await createUser(MEMBER, { name: 'Member', roleIds: [plainRoleId] })

  ownerCookie = await login(app, OWNER)
  recruiterCookie = await login(app, RECRUITER)
  memberCookie = await login(app, MEMBER)
})

afterAll(async () => {
  await cleanFixtures(TAG)
  await closeDatabase()
})

/** The envelope every list endpoint answers with. */
type Page = { items: { email: string }[]; total: number; page: number; perPage: number }

describe('GET /users', () => {
  it('needs a session', async () => {
    expect((await request(app, '/users')).status).toBe(401)
  })

  it('lists users with their roles', async () => {
    const res = await request(app, '/users', { cookie: memberCookie })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { items: { email: string; roles: { roleKey: string }[] }[] }
    const member = body.items.find((item) => item.email === MEMBER)

    expect(member?.roles.map((role) => role.roleKey)).toEqual([`${TAG}-plain`])
  })

  it('filters by status and by search term', async () => {
    const res = await request(app, `/users?q=recruiter&status=active`, { cookie: ownerCookie })
    const body = (await res.json()) as { items: { email: string }[] }

    expect(body.items.map((item) => item.email)).toEqual([RECRUITER])
  })

  it('filters by role', async () => {
    const res = await request(app, `/users?roleId=${plainRoleId}`, { cookie: ownerCookie })
    const body = (await res.json()) as { items: { email: string }[] }

    expect(body.items.map((item) => item.email)).toEqual([MEMBER])
  })

  it('pages, and page two does not repeat page one', async () => {
    const query = 'perPage=2&sort=email&order=asc'

    const first = await request(app, `/users?${query}`, { cookie: ownerCookie })
    const page1 = (await first.json()) as Page

    expect(page1.items).toHaveLength(2)
    expect(page1.page).toBe(1)
    expect(page1.perPage).toBe(2)
    expect(page1.total).toBeGreaterThanOrEqual(3)

    const second = await request(app, `/users?${query}&page=2`, { cookie: ownerCookie })
    const page2 = (await second.json()) as Page

    expect(page2.page).toBe(2)
    expect(page2.total).toBe(page1.total)

    const seen = page1.items.map((item) => item.email)
    expect(page2.items.some((item) => seen.includes(item.email))).toBe(false)
  })

  it('counts what the filter matches, not the whole table', async () => {
    const all = (await (
      await request(app, '/users?perPage=1', { cookie: ownerCookie })
    ).json()) as Page
    const filtered = (await (
      await request(app, '/users?perPage=1&q=recruiter', { cookie: ownerCookie })
    ).json()) as Page

    expect(filtered.total).toBe(1)
    expect(all.total).toBeGreaterThan(filtered.total)
  })

  it('sorts both ways over the same rows', async () => {
    const up = (await (
      await request(app, '/users?perPage=100&sort=email&order=asc', { cookie: ownerCookie })
    ).json()) as Page
    const down = (await (
      await request(app, '/users?perPage=100&sort=email&order=desc', { cookie: ownerCookie })
    ).json()) as Page

    expect(down.items.map((item) => item.email)).toEqual(
      [...up.items.map((item) => item.email)].reverse(),
    )
  })

  /**
   * The two ways somebody probes a list endpoint. Neither reaches the database: `perPage`
   * is capped and `sort` is an enum, so an unknown column name is a validation failure
   * rather than a query.
   */
  it('refuses a page size past the cap and a sort key that is not on the list', async () => {
    const huge = await request(app, '/users?perPage=99999', { cookie: ownerCookie })
    expect(huge.status).toBe(400)

    const injected = await request(app, '/users?sort=password_hash', { cookie: ownerCookie })
    expect(injected.status).toBe(400)
    expect(await injected.json()).toMatchObject({ error: { code: 'bad_request' } })
  })
})

describe('POST /users', () => {
  it('is refused without user.invite', async () => {
    const res = await request(app, '/users', {
      method: 'POST',
      cookie: memberCookie,
      body: { email: emailFor(TAG, 'nope'), name: 'Nope', roleIds: [plainRoleId] },
    })

    expect(res.status).toBe(403)
  })

  it('creates an invited account and returns the token exactly once', async () => {
    const res = await request(app, '/users', {
      method: 'POST',
      cookie: ownerCookie,
      body: { email: emailFor(TAG, 'joiner'), name: 'New Joiner', roleIds: [plainRoleId] },
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { inviteToken: string; user: { status: string } }
    expect(body.user.status).toBe('invited')
    expect(body.inviteToken).toMatch(/^inv_/)

    // Only the hash is kept, so the list can never hand the token back out.
    const list = await request(app, '/users', { cookie: ownerCookie })
    expect(await list.text()).not.toContain(body.inviteToken)
  })

  it('refuses an address that is already in use', async () => {
    const res = await request(app, '/users', {
      method: 'POST',
      cookie: ownerCookie,
      body: { email: MEMBER, name: 'Duplicate', roleIds: [plainRoleId] },
    })

    expect(res.status).toBe(409)
  })

  /**
   * The escalation this endpoint exists to prevent: a recruiter creating an account with a
   * role they do not hold, then signing in as it.
   */
  it('refuses to hand out a role holding permissions the inviter lacks', async () => {
    const res = await request(app, '/users', {
      method: 'POST',
      cookie: recruiterCookie,
      body: { email: emailFor(TAG, 'promoted'), name: 'Promoted', roleIds: [powerfulRoleId] },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: {
        code: 'forbidden',
        details: { permissions: expect.arrayContaining(['audit.read']) },
      },
    })

    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, emailFor(TAG, 'promoted')))
    expect(row).toBeUndefined()
  })
})

describe('PATCH /users/:id', () => {
  it('renames a user and replaces their roles wholesale', async () => {
    const res = await request(app, `/users/${memberId}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: { name: 'Member Renamed', roleIds: [plainRoleId] },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ user: { name: 'Member Renamed' } })
  })

  it('rejects an empty change set', async () => {
    const res = await request(app, `/users/${memberId}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: {},
    })

    expect(res.status).toBe(400)
  })

  it('is 404 for a user that does not exist', async () => {
    const res = await request(app, '/users/00000000-0000-7000-8000-000000000000', {
      method: 'PATCH',
      cookie: ownerCookie,
      body: { name: 'Ghost' },
    })

    expect(res.status).toBe(404)
  })
})

describe('POST /users/:id/status', () => {
  it('needs user.disable, which the recruiter does not hold', async () => {
    const res = await request(app, `/users/${memberId}/status`, {
      method: 'POST',
      cookie: recruiterCookie,
      body: { status: 'disabled' },
    })

    expect(res.status).toBe(403)
  })

  it('refuses to disable your own account', async () => {
    const res = await request(app, `/users/${ownerId}/status`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { status: 'disabled' },
    })

    // The button that would undo it is behind the access you just took from yourself.
    expect(res.status).toBe(400)
  })

  /**
   * The property worth having a real database for: disabling writes no session sweep, and
   * the session still dies — because every lookup joins `users` on `status = 'active'`.
   */
  it('kills the disabled user’s existing session on their very next request', async () => {
    expect((await request(app, '/users', { cookie: memberCookie })).status).toBe(200)

    const disable = await request(app, `/users/${memberId}/status`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { status: 'disabled' },
    })
    expect(disable.status).toBe(200)

    expect((await request(app, '/users', { cookie: memberCookie })).status).toBe(401)
  })

  it('re-enables an account, and its owner can sign in again', async () => {
    const res = await request(app, `/users/${memberId}/status`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { status: 'active' },
    })

    expect(res.status).toBe(200)
    await expect(login(app, MEMBER)).resolves.toBeTruthy()
  })

  it('refuses to activate an account that has not accepted its invitation', async () => {
    const [invited] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, emailFor(TAG, 'joiner')))

    const res = await request(app, `/users/${invited?.id}/status`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { status: 'active' },
    })

    expect(res.status).toBe(400)
  })
})

describe('POST /users/:id/invite', () => {
  it('rotates the invitation token instead of issuing a second one', async () => {
    const [invited] = await db
      .select({ id: users.id, hash: users.inviteTokenHash })
      .from(users)
      .where(eq(users.email, emailFor(TAG, 'joiner')))

    const res = await request(app, `/users/${invited?.id}/invite`, {
      method: 'POST',
      cookie: ownerCookie,
    })
    expect(res.status).toBe(200)

    const [after] = await db
      .select({ hash: users.inviteTokenHash })
      .from(users)
      .where(eq(users.email, emailFor(TAG, 'joiner')))

    // A link that already went to the wrong inbox has to stop working.
    expect(after?.hash).not.toBe(invited?.hash)
  })

  it('refuses to re-send to an account that is already active', async () => {
    const res = await request(app, `/users/${memberId}/invite`, {
      method: 'POST',
      cookie: ownerCookie,
    })

    expect(res.status).toBe(400)
  })
})
