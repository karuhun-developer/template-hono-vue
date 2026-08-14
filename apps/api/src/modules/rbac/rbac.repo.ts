import { isPermissionKey, type PermissionKey } from '@app/contract'
import { eq } from 'drizzle-orm'

import { db } from '#db/client'
import { rolePermissions, userRoles } from '#db/schema'

/**
 * Works out what a user is allowed to do.
 *
 * The answer is a flat set, because in a single-tenant application there is exactly one
 * scope. If you later add tenants or branches, this is the type that has to grow a second
 * dimension — and docs/guides/add-multi-tenancy.md walks through what that costs.
 */

export type AccessContext = {
  userId: string
  permissions: ReadonlySet<PermissionKey>
}

/**
 * Load a user's permissions in one query.
 *
 * The `userId` comes from a verified session row, never from a client.
 */
export async function loadAccess(userId: string): Promise<AccessContext> {
  const rows = await db
    .select({ permissionKey: rolePermissions.permissionKey })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
    .where(eq(userRoles.userId, userId))

  const permissions = new Set<PermissionKey>()
  for (const row of rows) {
    // A key that is in the database but has since disappeared from the catalog is ignored.
    // An unrecognised permission must not grant access to anything.
    if (isPermissionKey(row.permissionKey)) permissions.add(row.permissionKey)
  }

  return { userId, permissions }
}

/** Is this user allowed to do `permission`? */
export function can(access: AccessContext, permission: PermissionKey): boolean {
  return access.permissions.has(permission)
}

/** Everything the user holds — used to render the console's navigation. */
export function allPermissions(access: AccessContext): PermissionKey[] {
  return [...access.permissions].sort()
}
