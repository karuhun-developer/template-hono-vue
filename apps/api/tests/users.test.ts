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
/** Holds `user.create` and nothing else worth having: the same escalation, the other door. */
const STAFFER = emailFor(TAG, 'staffer')
const MEMBER = emailFor(TAG, 'member')
/** Switched off, and holding nothing — here so a status filter has two answers to pick from. */
const DORMANT = emailFor(TAG, 'dormant')

let ownerCookie: string
let recruiterCookie: string
let stafferCookie: string
let memberCookie: string
let memberId: string
let ownerId: string
let powerfulRoleId: string
let recruiterRoleId: string
let stafferRoleId: string
let plainRoleId: string

beforeAll(async () => {
  await cleanFixtures(TAG)
  await ensureCatalog()

  powerfulRoleId = await createRole(TAG, 'powerful', [
    'user.read',
    'user.invite',
    'user.create',
    'user.update',
    'user.disable',
    'user.delete',
    'user.reset_password',
    'role.read',
    'role.manage',
    'audit.read',
  ])
  recruiterRoleId = await createRole(TAG, 'recruiter', ['user.read', 'user.invite', 'user.update'])
  stafferRoleId = await createRole(TAG, 'staffer', ['user.read', 'user.create'])
  plainRoleId = await createRole(TAG, 'plain', ['user.read'])

  ownerId = await createUser(OWNER, { name: 'Owner', roleIds: [powerfulRoleId] })
  await createUser(RECRUITER, { name: 'Recruiter', roleIds: [recruiterRoleId] })
  await createUser(STAFFER, { name: 'Staffer', roleIds: [stafferRoleId] })
  memberId = await createUser(MEMBER, { name: 'Member', roleIds: [plainRoleId] })
  await createUser(DORMANT, { name: 'Dormant', status: 'disabled' })

  ownerCookie = await login(app, OWNER)
  recruiterCookie = await login(app, RECRUITER)
  stafferCookie = await login(app, STAFFER)
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

  /**
   * The console's facet filters are checkbox lists, so they send the same parameter once
   * per tick. A schema that only understood a single value would answer the first tick and
   * drop the rest, which looks like rows going missing.
   */
  it('takes a filter given more than once as a set', async () => {
    const statuses = await request(app, '/users?perPage=100&status=active&status=disabled', {
      cookie: ownerCookie,
    })
    const byStatus = (await statuses.json()) as Page

    expect(byStatus.items.map((item) => item.email)).toContain(DORMANT)
    expect(byStatus.items.map((item) => item.email)).toContain(MEMBER)

    const roles = await request(
      app,
      `/users?perPage=100&roleId=${plainRoleId}&roleId=${recruiterRoleId}`,
      { cookie: ownerCookie },
    )
    const byRole = (await roles.json()) as Page

    expect(byRole.items.map((item) => item.email).sort()).toEqual([MEMBER, RECRUITER].sort())
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

describe('GET /users/:id', () => {
  it('answers with one user and the roles they hold', async () => {
    const res = await request(app, `/users/${memberId}`, { cookie: memberCookie })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { user: { email: string; roles: { roleKey: string }[] } }
    expect(body.user.email).toBe(MEMBER)
    expect(body.user.roles.map((role) => role.roleKey)).toEqual([`${TAG}-plain`])
  })

  it('is 404 for a user that does not exist', async () => {
    const res = await request(app, '/users/00000000-0000-7000-8000-000000000000', {
      cookie: ownerCookie,
    })

    expect(res.status).toBe(404)
  })

  it('is 400 for an id that is not an id', async () => {
    const res = await request(app, '/users/not-a-uuid', { cookie: ownerCookie })
    expect(res.status).toBe(400)
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

describe('POST /users/create', () => {
  const CREATED = emailFor(TAG, 'created')
  const CREATED_PASSWORD = 'created-password-2026'

  /**
   * The test the route split exists for. A recruiter may hand out invitations all day; the
   * account whose password they choose is a different act, and holding one permission must
   * not quietly confer the other.
   */
  it('is refused for a caller who holds user.invite but not user.create', async () => {
    const res = await request(app, '/users/create', {
      method: 'POST',
      cookie: recruiterCookie,
      body: {
        email: emailFor(TAG, 'shortcut'),
        name: 'Shortcut',
        password: CREATED_PASSWORD,
        roleIds: [plainRoleId],
      },
    })

    expect(res.status).toBe(403)
  })

  it('creates an active account that can sign in straight away', async () => {
    const res = await request(app, '/users/create', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        email: CREATED,
        name: 'Created Directly',
        password: CREATED_PASSWORD,
        roleIds: [plainRoleId],
      },
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      user: { email: string; status: string; roles: { roleKey: string }[] }
    }
    expect(body.user.status).toBe('active')
    expect(body.user.roles.map((role) => role.roleKey)).toEqual([`${TAG}-plain`])

    // No invitation to accept, no token to hand over: the password is already set, which is
    // the entire difference between this endpoint and `POST /users`.
    await expect(login(app, CREATED, CREATED_PASSWORD)).resolves.toBeTruthy()
  })

  it('never lets the password out again, in the response or the list', async () => {
    const list = await request(app, '/users?perPage=100', { cookie: ownerCookie })
    expect(await list.text()).not.toContain(CREATED_PASSWORD)
  })

  it('refuses a password shorter than the rule for setting one', async () => {
    const res = await request(app, '/users/create', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        email: emailFor(TAG, 'weak'),
        name: 'Weak',
        password: 'sevench',
        roleIds: [plainRoleId],
      },
    })

    expect(res.status).toBe(400)
  })

  it('refuses an address that is already in use', async () => {
    const res = await request(app, '/users/create', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        email: MEMBER,
        name: 'Duplicate',
        password: CREATED_PASSWORD,
        roleIds: [plainRoleId],
      },
    })

    expect(res.status).toBe(409)
  })

  /** The same escalation `POST /users` refuses, through the other door. */
  it('refuses to hand out a role holding permissions the creator lacks', async () => {
    const res = await request(app, '/users/create', {
      method: 'POST',
      cookie: stafferCookie,
      body: {
        email: emailFor(TAG, 'promoted-directly'),
        name: 'Promoted',
        password: CREATED_PASSWORD,
        roleIds: [powerfulRoleId],
      },
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
      .where(eq(users.email, emailFor(TAG, 'promoted-directly')))
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

describe('DELETE /users/:id and POST /users/:id/restore', () => {
  const LEAVER = emailFor(TAG, 'leaver')
  let leaverId: string
  let leaverCookie: string

  beforeAll(async () => {
    leaverId = await createUser(LEAVER, { name: 'Leaver', roleIds: [plainRoleId] })
    leaverCookie = await login(app, LEAVER)
  })

  it('needs user.delete, which the recruiter does not hold', async () => {
    const removed = await request(app, `/users/${leaverId}`, {
      method: 'DELETE',
      cookie: recruiterCookie,
    })
    expect(removed.status).toBe(403)

    const restored = await request(app, `/users/${leaverId}/restore`, {
      method: 'POST',
      cookie: recruiterCookie,
    })
    expect(restored.status).toBe(403)
  })

  /**
   * And this refusal is what keeps an installation repairable: whoever can reach this route
   * holds `user.delete` and is signed in, so deleting somebody else can never remove the
   * last account able to manage users.
   */
  it('refuses to delete your own account', async () => {
    const res = await request(app, `/users/${ownerId}`, { method: 'DELETE', cookie: ownerCookie })
    expect(res.status).toBe(400)
  })

  /**
   * The property worth having a real database for, and the twin of the disable test above:
   * no session sweep is written, and the session dies anyway — `findLiveSession()` joins
   * `deleted_at IS NULL`.
   */
  it('hides the row and kills the deleted user’s session on their very next request', async () => {
    expect((await request(app, '/users', { cookie: leaverCookie })).status).toBe(200)

    const res = await request(app, `/users/${leaverId}`, { method: 'DELETE', cookie: ownerCookie })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { user: { deletedAt: string | null } }
    expect(body.user.deletedAt).not.toBeNull()

    const list = (await (
      await request(app, '/users?perPage=100', { cookie: ownerCookie })
    ).json()) as Page
    expect(list.items.map((item) => item.email)).not.toContain(LEAVER)

    expect((await request(app, '/users', { cookie: leaverCookie })).status).toBe(401)
  })

  it('shows deleted accounts only when they are asked for', async () => {
    const res = await request(app, '/users?perPage=100&includeDeleted=true', {
      cookie: ownerCookie,
    })
    const body = (await res.json()) as Page

    expect(body.items.map((item) => item.email)).toContain(LEAVER)
  })

  /** A row the list can show must not 404 when it is opened. */
  it('still answers GET /users/:id for a deleted account', async () => {
    const res = await request(app, `/users/${leaverId}`, { cookie: ownerCookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ user: { email: LEAVER } })
  })

  it('deletes an already deleted account without complaining', async () => {
    const res = await request(app, `/users/${leaverId}`, { method: 'DELETE', cookie: ownerCookie })
    expect(res.status).toBe(200)
  })

  /**
   * The address stays reserved on purpose — `users_email_key` has no `deleted_at`
   * predicate. Releasing it would let a brand-new account inherit a departed person's audit
   * trail, because `audit_logs.actor_label` stores the email as it read at the time.
   */
  it('refuses to re-invite a deleted address, and says to restore it instead', async () => {
    const res = await request(app, '/users', {
      method: 'POST',
      cookie: ownerCookie,
      body: { email: LEAVER, name: 'Leaver Again', roleIds: [plainRoleId] },
    })

    expect(res.status).toBe(409)
    expect(await res.text()).toContain('Restore it instead.')
  })

  it('restores the account, and its owner can sign in afresh', async () => {
    const res = await request(app, `/users/${leaverId}/restore`, {
      method: 'POST',
      cookie: ownerCookie,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ user: { deletedAt: null, status: 'active' } })

    await expect(login(app, LEAVER)).resolves.toBeTruthy()
  })

  it('restores an account that was never deleted without complaining', async () => {
    const res = await request(app, `/users/${leaverId}/restore`, {
      method: 'POST',
      cookie: ownerCookie,
    })

    expect(res.status).toBe(200)
  })

  /**
   * `z.coerce.boolean()` would read the string `"false"` as `true`, so the parameter is an
   * enum of two strings — and anything else is a validation failure rather than a guess.
   */
  it('refuses an includeDeleted that is not a boolean', async () => {
    const res = await request(app, '/users?includeDeleted=notabool', { cookie: ownerCookie })
    expect(res.status).toBe(400)
  })
})

describe('POST /users/:id/reset-password', () => {
  /** Holds the reset key, and nothing else worth taking — the escalation subject here. */
  const SUPPORT = emailFor(TAG, 'support')

  let supportCookie: string

  beforeAll(async () => {
    const supportRoleId = await createRole(TAG, 'support', ['user.read', 'user.reset_password'])
    await createUser(SUPPORT, { name: 'Support', roleIds: [supportRoleId] })
    supportCookie = await login(app, SUPPORT)
  })

  /**
   * The recruiter holds `user.update`. Starting a credential flow on somebody else's
   * account is not the same act as correcting the spelling of their name, which is the
   * entire reason `user.reset_password` is its own key.
   */
  it('is refused to a caller who can edit users but not reset their passwords', async () => {
    const res = await request(app, `/users/${memberId}/reset-password`, {
      method: 'POST',
      cookie: recruiterCookie,
    })

    expect(res.status).toBe(403)
  })

  it('issues a token, once, and stores only its hash', async () => {
    const res = await request(app, `/users/${memberId}/reset-password`, {
      method: 'POST',
      cookie: ownerCookie,
    })

    expect(res.status).toBe(200)

    const body = (await res.json()) as { user: { email: string }; resetToken: string }
    expect(body.user.email).toBe(MEMBER)
    expect(body.resetToken).toMatch(/^rst_/)

    const [row] = await db
      .select({ hash: users.passwordResetTokenHash })
      .from(users)
      .where(eq(users.id, memberId))

    expect(row?.hash).toBeTruthy()
    expect(row?.hash).not.toBe(body.resetToken)
  })

  /**
   * A reset link is a way of taking an account over, and taking an account over is a way of
   * holding its permissions — so the rule that stops `user.invite` meaning "may become
   * owner" has to hold on this route too, from the other direction.
   */
  it('refuses to reset an account more powerful than the caller', async () => {
    const res = await request(app, `/users/${ownerId}/reset-password`, {
      method: 'POST',
      cookie: supportCookie,
    })

    expect(res.status).toBe(403)

    const body = (await res.json()) as { error: { details?: { permissions?: string[] } } }
    expect(body.error.details?.permissions).toContain('audit.read')
  })

  it('lets that same caller reset somebody who holds no more than they do', async () => {
    const res = await request(app, `/users/${memberId}/reset-password`, {
      method: 'POST',
      cookie: supportCookie,
    })

    expect(res.status).toBe(200)
  })

  it('refuses an account that has never accepted its invitation', async () => {
    const invitedId = await createUser(emailFor(TAG, 'unopened'), { status: 'invited' })

    const res = await request(app, `/users/${invitedId}/reset-password`, {
      method: 'POST',
      cookie: ownerCookie,
    })

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('re-send its invitation instead')
  })

  it('refuses a disabled account', async () => {
    const [dormant] = await db.select({ id: users.id }).from(users).where(eq(users.email, DORMANT))

    const res = await request(app, `/users/${dormant?.id}/reset-password`, {
      method: 'POST',
      cookie: ownerCookie,
    })

    expect(res.status).toBe(400)
  })

  it('is a 404 for a user who does not exist', async () => {
    const res = await request(app, `/users/${crypto.randomUUID()}/reset-password`, {
      method: 'POST',
      cookie: ownerCookie,
    })

    expect(res.status).toBe(404)
  })
})
