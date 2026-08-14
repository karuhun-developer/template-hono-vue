import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { app } from '#app'
import { closeDatabase } from '#db/client'

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
 * Role management against a real Postgres.
 *
 * One question is being asked over and over here: **can `role.manage` be turned into more
 * access than the person already has?** Both directions of the answer matter — writing a
 * permission you do not hold, and quietly removing one you do not hold.
 */

const TAG = 'roles'
const OWNER = emailFor(TAG, 'owner')
/** Holds `role.manage`, but neither `user.disable` nor `audit.read`. */
const ADMIN = emailFor(TAG, 'admin')
const VIEWER = emailFor(TAG, 'viewer')

let ownerCookie: string
let adminCookie: string
let viewerCookie: string
let ownerRoleId: string
let systemRoleId: string

beforeAll(async () => {
  await cleanFixtures(TAG)
  await ensureCatalog()

  ownerRoleId = await createRole(TAG, 'owner', [
    'user.read',
    'user.invite',
    'user.update',
    'user.disable',
    'role.read',
    'role.manage',
    'audit.read',
  ])
  const adminRoleId = await createRole(TAG, 'admin', [
    'user.read',
    'user.invite',
    'user.update',
    'role.read',
    'role.manage',
  ])
  const viewerRoleId = await createRole(TAG, 'viewer', ['user.read'])
  systemRoleId = await createRole(TAG, 'builtin', ['user.read'], { isSystem: true })

  await createUser(OWNER, { name: 'Owner', roleIds: [ownerRoleId] })
  await createUser(ADMIN, { name: 'Admin', roleIds: [adminRoleId] })
  await createUser(VIEWER, { name: 'Viewer', roleIds: [viewerRoleId] })

  ownerCookie = await login(app, OWNER)
  adminCookie = await login(app, ADMIN)
  viewerCookie = await login(app, VIEWER)
})

afterAll(async () => {
  await cleanFixtures(TAG)
  await closeDatabase()
})

describe('GET /roles', () => {
  it('is refused without role.read', async () => {
    expect((await request(app, '/roles', { cookie: viewerCookie })).status).toBe(403)
  })

  it('lists roles with their permissions and how many people hold them', async () => {
    const res = await request(app, '/roles', { cookie: adminCookie })
    const body = (await res.json()) as {
      items: { key: string; permissions: string[]; usedBy: number }[]
    }
    const viewer = body.items.find((role) => role.key === `${TAG}-viewer`)

    expect(viewer).toMatchObject({ permissions: ['user.read'], usedBy: 1 })
  })
})

describe('GET /roles/permissions', () => {
  it('returns the catalog together with what the caller holds', async () => {
    const res = await request(app, '/roles/permissions', { cookie: adminCookie })
    const body = (await res.json()) as { groups: { key: string }[]; granted: string[] }

    expect(body.groups.map((group) => group.key)).toEqual(['users', 'roles', 'audit'])
    // What decides which ticks the matrix renders as editable.
    expect(body.granted).not.toContain('audit.read')
    expect(body.granted).toContain('role.manage')
  })

  it('is matched as a literal path, not as a role id', async () => {
    // Registered after `/:id` it would be parsed as a uuid and answered with a 400.
    expect((await request(app, '/roles/permissions', { cookie: adminCookie })).status).toBe(200)
  })
})

describe('POST /roles', () => {
  it('creates a role and derives its key from the name', async () => {
    const res = await request(app, '/roles', {
      method: 'POST',
      cookie: ownerCookie,
      body: { name: `${TAG} Support Desk`, permissions: ['user.read', 'role.read'] },
    })

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      role: { key: `${TAG}-support-desk`, isSystem: false, usedBy: 0 },
    })
  })

  it('refuses permissions the creator does not hold', async () => {
    const res = await request(app, '/roles', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: `${TAG} Escalation`, permissions: ['user.read', 'audit.read'] },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: { code: 'forbidden', details: { permissions: ['audit.read'] } },
    })
  })

  it('rejects a permission key that is not in the catalog', async () => {
    const res = await request(app, '/roles', {
      method: 'POST',
      cookie: ownerCookie,
      body: { name: `${TAG} Typo`, permissions: ['user.raed'] },
    })

    // Caught at the edge: a mistyped key in `role_permissions` would look granted and
    // never match anything.
    expect(res.status).toBe(400)
  })
})

describe('PATCH /roles/:id', () => {
  it('updates the permissions of a role within reach', async () => {
    const created = await request(app, '/roles', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: `${TAG} Editable`, permissions: ['user.read'] },
    })
    const { role } = (await created.json()) as { role: { id: string } }

    const res = await request(app, `/roles/${role.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: { permissions: ['user.read', 'user.invite'] },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ role: { permissions: ['user.invite', 'user.read'] } })
  })

  /**
   * The second direction of the grantable rule. The console renders these ticks disabled;
   * a payload that drops them is a client ignoring that, and the result would be an admin
   * silently stripping `audit.read` from the owner role.
   */
  it('refuses to remove permissions the editor does not hold', async () => {
    const res = await request(app, `/roles/${ownerRoleId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: {
        permissions: ['user.read', 'user.invite', 'user.update', 'role.read', 'role.manage'],
      },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: {
        code: 'forbidden',
        details: { permissions: expect.arrayContaining(['audit.read', 'user.disable']) },
      },
    })
  })

  it('lets the owner edit the same role, because they hold everything in it', async () => {
    const res = await request(app, `/roles/${ownerRoleId}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: { description: 'Everything.' },
    })

    expect(res.status).toBe(200)
  })
})

describe('DELETE /roles/:id', () => {
  it('refuses to delete a built-in role', async () => {
    const res = await request(app, `/roles/${systemRoleId}`, {
      method: 'DELETE',
      cookie: ownerCookie,
    })

    expect(res.status).toBe(400)
  })

  it('refuses to delete a role somebody still holds', async () => {
    const list = await request(app, '/roles', { cookie: ownerCookie })
    const { items } = (await list.json()) as { items: { id: string; key: string }[] }
    const viewer = items.find((role) => role.key === `${TAG}-viewer`)

    const res = await request(app, `/roles/${viewer?.id}`, {
      method: 'DELETE',
      cookie: ownerCookie,
    })

    expect(res.status).toBe(409)
  })

  it('deletes a role nobody holds', async () => {
    const created = await request(app, '/roles', {
      method: 'POST',
      cookie: ownerCookie,
      body: { name: `${TAG} Temporary`, permissions: ['user.read'] },
    })
    const { role } = (await created.json()) as { role: { id: string } }

    const res = await request(app, `/roles/${role.id}`, { method: 'DELETE', cookie: ownerCookie })

    expect(res.status).toBe(200)
    expect(
      (await request(app, `/roles/${role.id}`, { method: 'DELETE', cookie: ownerCookie })).status,
    ).toBe(404)
  })
})
