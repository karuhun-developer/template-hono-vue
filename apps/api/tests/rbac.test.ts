import { PERMISSIONS, SYSTEM_ROLES } from '@app/contract'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { app } from '#app'
import { closeDatabase, db } from '#db/client'
import { permissions as permissionsTable, rolePermissions, roles } from '#db/schema'
import { errorHandler, notFoundHandler } from '#middleware/error'
import { requireAnyPermission, requirePermission } from '#middleware/rbac'
import { requestContext, type AppBindings } from '#middleware/request-context'
import { requireAuth, sessionContext } from '#middleware/session'
import { allPermissions, can, loadAccess } from '#modules/rbac/rbac.repo'
import { provisionSystemRoles, syncPermissionCatalog } from '#modules/rbac/rbac.service'

import { cleanFixtures, createRole, createUser, emailFor, login, request } from './support/world'

/**
 * The permission layer itself: what `loadAccess()` returns, what the guards do with it, and
 * what provisioning writes.
 *
 * The guards are mounted on a throwaway app rather than reached through the real routes,
 * because the rule most worth pinning down — several permissions mean **all** of them — has
 * no endpoint that demonstrates it in a starter this small. That is exactly the kind of rule
 * somebody rewrites later having assumed the other meaning.
 */

const TAG = 'rbac'
const HOLDER = emailFor(TAG, 'holder')
const PARTIAL = emailFor(TAG, 'partial')

let holderCookie: string
let partialCookie: string
let holderId: string

/**
 * A miniature app carrying only the guards under test. It gets the same error handler as
 * the real one, because "which status a refusal has" is half of what is being asserted.
 */
const guarded = new Hono<AppBindings>()
guarded.use('*', requestContext())
guarded.use('*', sessionContext())
guarded.use('*', requireAuth())
guarded.onError(errorHandler)
guarded.notFound(notFoundHandler)
guarded.get('/all', requirePermission('user.read', 'audit.read'), (c) => c.json({ ok: true }))
guarded.get('/any', requireAnyPermission('user.read', 'audit.read'), (c) => c.json({ ok: true }))

beforeAll(async () => {
  await cleanFixtures(TAG)
  await syncPermissionCatalog(db)

  const bothId = await createRole(TAG, 'both', ['user.read', 'audit.read'])
  const oneId = await createRole(TAG, 'one', ['user.read'])

  holderId = await createUser(HOLDER, { roleIds: [bothId] })
  await createUser(PARTIAL, { roleIds: [oneId] })

  // Sessions are issued by the real app; `guarded` only reads the cookie back out.
  holderCookie = await login(app, HOLDER)
  partialCookie = await login(app, PARTIAL)
})

afterAll(async () => {
  await cleanFixtures(TAG)
  await closeDatabase()
})

describe('loadAccess', () => {
  it('collects the permissions of every role a user holds', async () => {
    const access = await loadAccess(holderId)

    expect(allPermissions(access)).toEqual(['audit.read', 'user.read'])
    expect(can(access, 'user.read')).toBe(true)
    expect(can(access, 'role.manage')).toBe(false)
  })

  it('ignores keys the code catalog no longer knows about', async () => {
    const strayRoleId = await createRole(TAG, 'stray', [])
    // A key left behind by a rename: present in `permissions`, absent from `PERMISSIONS`.
    await db
      .insert(permissionsTable)
      .values({ key: 'legacy.thing', group: 'users', label: 'Left over from a rename' })
    await db.insert(rolePermissions).values({ roleId: strayRoleId, permissionKey: 'legacy.thing' })

    const strayUserId = await createUser(emailFor(TAG, 'stray'), { roleIds: [strayRoleId] })
    const access = await loadAccess(strayUserId)

    // An unrecognised permission must not grant anything, anywhere.
    expect(allPermissions(access)).toEqual([])

    await db.delete(permissionsTable).where(eq(permissionsTable.key, 'legacy.thing'))
  })
})

describe('requirePermission', () => {
  it('means all of the listed permissions, not any of them', async () => {
    expect((await request(guarded, '/all', { cookie: holderCookie })).status).toBe(200)
    expect((await request(guarded, '/all', { cookie: partialCookie })).status).toBe(403)
  })

  it('answers 401, not 403, when there is no session at all', async () => {
    const res = await request(guarded, '/all')

    // The difference decides whether the console sends somebody to the login screen or to
    // /forbidden — and telling an anonymous caller "forbidden" strands them there.
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } })
  })
})

describe('requireAnyPermission', () => {
  it('lets through whoever holds at least one of them', async () => {
    expect((await request(guarded, '/any', { cookie: partialCookie })).status).toBe(200)
  })
})

describe('syncPermissionCatalog', () => {
  it('writes the whole catalog, and writing it twice changes nothing', async () => {
    const first = await syncPermissionCatalog(db)
    const second = await syncPermissionCatalog(db)

    expect(first.total).toBe(PERMISSIONS.length)
    expect(second.total).toBe(PERMISSIONS.length)
  })

  it('reports a key the catalog has dropped instead of deleting it', async () => {
    await db
      .insert(permissionsTable)
      .values({ key: 'legacy.orphan', group: 'users', label: 'Orphan' })

    const result = await syncPermissionCatalog(db)

    // Deleting would cascade into `role_permissions`: one typo during a rename would strip
    // access from everybody at once, with no way back short of a restore.
    expect(result.orphaned).toContain('legacy.orphan')

    const [survivor] = await db
      .select({ key: permissionsTable.key })
      .from(permissionsTable)
      .where(eq(permissionsTable.key, 'legacy.orphan'))
    expect(survivor).toBeDefined()

    await db.delete(permissionsTable).where(eq(permissionsTable.key, 'legacy.orphan'))
  })
})

describe('provisionSystemRoles', () => {
  it('creates each system role once and leaves it alone afterwards', async () => {
    await provisionSystemRoles(db)
    const second = await provisionSystemRoles(db)

    // Re-running the seeder must not put an edited permission matrix back to the default.
    expect(second.created).toEqual([])

    const provisioned = await db
      .select({ key: roles.key })
      .from(roles)
      .where(eq(roles.isSystem, true))

    expect(provisioned.map((role) => role.key)).toEqual(
      expect.arrayContaining(SYSTEM_ROLES.map((template) => template.key)),
    )
  })

  it('tops up a wildcard role with permissions added after it was created', async () => {
    await provisionSystemRoles(db)

    const [owner] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, 'owner'))
      .limit(1)
    if (!owner) throw new Error('the owner role was not provisioned')

    // Stands in for a permission that shipped later: `'*'` promised the whole catalog, and
    // rows frozen at install time cannot keep that promise.
    await db
      .delete(rolePermissions)
      .where(
        and(eq(rolePermissions.roleId, owner.id), eq(rolePermissions.permissionKey, 'audit.read')),
      )
    await provisionSystemRoles(db)

    const granted = await db
      .select({ key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, owner.id))

    expect(granted.map((row) => row.key)).toContain('audit.read')
  })
})
