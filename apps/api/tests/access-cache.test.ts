import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The optional permission cache — the one subsystem here whose failure mode is a security
 * one rather than a slow page.
 *
 * `CACHE_ACCESS_PERMISSIONS` is off everywhere else, `vitest.config.ts` included, because
 * that is what an installation gets by default and the other suites should exercise what an
 * installation gets. It is turned on **for this file only**.
 *
 * `vi.hoisted` is what makes that possible: it runs before the imports below, and `env.ts`
 * parses `process.env` once at module load and then freezes the result. Vitest gives each
 * test file its own module registry, so this reaches this file's copy of `env` and no other's.
 * A suite-wide flag was the alternative, and it would make every existing assertion in the
 * repository depend on this invalidation matrix being complete — true today, and a very
 * confusing way to find out it had stopped being true.
 */
vi.hoisted(() => {
  process.env.CACHE_ACCESS_PERMISSIONS = 'true'
  process.env.CACHE_ACCESS_TTL_SECONDS = '60'
})

import { app } from '#app'
import { cache } from '#cache/cache'
import { closeDatabase, db } from '#db/client'
import { rolePermissions } from '#db/schema'
import { env } from '#env'
import { allPermissions, forgetAccess, loadAccess } from '#modules/rbac/rbac.repo'
import { syncPermissionCatalog } from '#modules/rbac/rbac.service'

import { cleanFixtures, createRole, createUser, emailFor, login, request } from './support/world'

const TAG = 'accesscache'
const MANAGER = emailFor(TAG, 'manager')
const SUBJECT = emailFor(TAG, 'subject')

let managerCookie: string
let subjectCookie: string
let subjectId: string
let readerRoleId: string
let ownRoleId: string
let uselessRoleId: string

beforeAll(async () => {
  // The whole file is meaningless if the flag did not take: every assertion below would pass
  // against an uncached `loadAccess`, which is exactly the shape of a suite that has quietly
  // stopped testing anything.
  if (!env.CACHE_ACCESS_PERMISSIONS) {
    throw new Error('CACHE_ACCESS_PERMISSIONS did not reach this file — see the note above')
  }

  await cleanFixtures(TAG)
  await syncPermissionCatalog(db)

  const managerRoleId = await createRole(TAG, 'manager', [
    'user.read',
    'user.update',
    'role.manage',
  ])
  readerRoleId = await createRole(TAG, 'reader', ['user.read'])
  ownRoleId = await createRole(TAG, 'own', ['user.read'])
  uselessRoleId = await createRole(TAG, 'useless', [])

  await createUser(MANAGER, { roleIds: [managerRoleId] })
  subjectId = await createUser(SUBJECT, { roleIds: [readerRoleId] })

  managerCookie = await login(app, MANAGER)
  subjectCookie = await login(app, SUBJECT)
})

afterAll(async () => {
  await cleanFixtures(TAG)
  await cache.clear()
  await closeDatabase()
})

describe('loadAccess with the cache on', () => {
  it('answers the second call from the entry rather than the database', async () => {
    const roleId = await createRole(TAG, 'served', ['user.read'])
    const userId = await createUser(emailFor(TAG, 'served'), { roleIds: [roleId] })

    expect(allPermissions(await loadAccess(userId))).toEqual(['user.read'])

    // Straight into `role_permissions`, behind the service layer's back — the only way to
    // prove the second answer came from the entry rather than from a query. Nothing in the
    // application grants a permission this way; a `psql` session does.
    await db.insert(rolePermissions).values({ roleId, permissionKey: 'audit.read' })

    expect(allPermissions(await loadAccess(userId))).toEqual(['user.read'])

    await forgetAccess(userId)
    expect(allPermissions(await loadAccess(userId))).toEqual(['audit.read', 'user.read'])
  })

  it('ignores a cached key the catalog no longer knows about', async () => {
    const userId = await createUser(emailFor(TAG, 'legacy'), { roleIds: [readerRoleId] })

    // The entry as it would read after a rename dropped the key. Raw keys are what is
    // cached, so this is the real stored shape rather than a contrived one.
    await cache.set(`access:${userId}`, ['user.read', 'legacy.thing'], 60_000)

    // Re-filtered on the way out. Without that filter a permission removed from the catalog
    // would keep granting whatever a route asks for until the entry expired.
    expect(allPermissions(await loadAccess(userId))).toEqual(['user.read'])
  })

  it('writes an entry only once somebody has been looked up', async () => {
    const userId = await createUser(emailFor(TAG, 'cold'), { roleIds: [readerRoleId] })

    expect(await cache.get(`access:${userId}`)).toBeUndefined()
    await loadAccess(userId)
    expect(await cache.get(`access:${userId}`)).toEqual(['user.read'])
  })
})

describe('invalidation, through the API', () => {
  it('lets the very next request see roles changed by PATCH /users/:id', async () => {
    // The request that warms the entry. Everything after it is the point of this file: the
    // permission is now cached, and taking it away has to be true immediately.
    expect((await request(app, '/users', { cookie: subjectCookie })).status).toBe(200)

    const patched = await request(app, `/users/${subjectId}`, {
      method: 'PATCH',
      cookie: managerCookie,
      body: { roleIds: [uselessRoleId] },
    })
    expect(patched.status).toBe(200)

    // Not "eventually", and not "once the TTL runs out". The next request.
    expect((await request(app, '/users', { cookie: subjectCookie })).status).toBe(403)
  })

  it('invalidates every holder when a role is edited', async () => {
    const holderEmail = emailFor(TAG, 'holder')
    await createUser(holderEmail, { roleIds: [ownRoleId] })
    const holderCookie = await login(app, holderEmail)

    expect((await request(app, '/users', { cookie: holderCookie })).status).toBe(200)

    // The fan-out case: the user was not touched at all, the role they hold was. A per-user
    // key cannot express that on its own, which is what `forgetAccessForRole` is for.
    const patched = await request(app, `/roles/${ownRoleId}`, {
      method: 'PATCH',
      cookie: managerCookie,
      body: { permissions: [] },
    })
    expect(patched.status).toBe(200)

    expect((await request(app, '/users', { cookie: holderCookie })).status).toBe(403)
  })
})
