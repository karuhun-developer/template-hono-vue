import { isPermissionKey, type PermissionKey } from '@app/contract'
import { asc, eq, inArray, sql } from 'drizzle-orm'

import { db, type DatabaseHandle } from '#db/client'
import { rolePermissions, roles, userRoles } from '#db/schema'

/**
 * Reading and writing roles and the permissions they carry.
 */

export type RoleRow = {
  id: string
  key: string
  name: string
  description: string | null
  isSystem: boolean
}

export type RoleWithPermissions = RoleRow & {
  permissions: PermissionKey[]
  /** How many users hold this role — what decides whether it can be deleted. */
  usedBy: number
}

const roleColumns = {
  id: roles.id,
  key: roles.key,
  name: roles.name,
  description: roles.description,
  isSystem: roles.isSystem,
} as const

export async function listRoles(): Promise<RoleWithPermissions[]> {
  const rows = await db.select(roleColumns).from(roles).orderBy(asc(roles.name))
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)
  const [permissions, usage] = await Promise.all([
    loadRolePermissions(db, ids),
    countUsersByRole(db, ids),
  ])

  return rows.map((row) => ({
    ...row,
    permissions: permissions.get(row.id) ?? [],
    usedBy: usage.get(row.id) ?? 0,
  }))
}

export async function findRole(
  handle: DatabaseHandle,
  id: string,
): Promise<RoleWithPermissions | null> {
  const [row] = await handle.select(roleColumns).from(roles).where(eq(roles.id, id)).limit(1)
  if (!row) return null

  const [permissions, usage] = await Promise.all([
    loadRolePermissions(handle, [id]),
    countUsersByRole(handle, [id]),
  ])

  return { ...row, permissions: permissions.get(id) ?? [], usedBy: usage.get(id) ?? 0 }
}

/**
 * The permissions of each role, filtered against the catalog in code.
 *
 * A key still sitting in the database but gone from `@app/contract` is **dropped here**,
 * exactly as it is in `loadAccess()`. An unrecognised permission must not grant anything,
 * and it must not show up in the role matrix as a mysterious tick nobody can clear.
 */
export async function loadRolePermissions(
  handle: DatabaseHandle,
  roleIds: readonly string[],
): Promise<Map<string, PermissionKey[]>> {
  if (roleIds.length === 0) return new Map()

  const rows = await handle
    .select({ roleId: rolePermissions.roleId, key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleId, [...roleIds]))

  const byRole = new Map<string, PermissionKey[]>()
  for (const row of rows) {
    if (!isPermissionKey(row.key)) continue
    const bucket = byRole.get(row.roleId) ?? []
    bucket.push(row.key)
    byRole.set(row.roleId, bucket)
  }

  for (const bucket of byRole.values()) bucket.sort()
  return byRole
}

async function countUsersByRole(
  handle: DatabaseHandle,
  roleIds: readonly string[],
): Promise<Map<string, number>> {
  if (roleIds.length === 0) return new Map()

  const rows = await handle
    .select({ roleId: userRoles.roleId, total: sql<number>`count(*)::int` })
    .from(userRoles)
    .where(inArray(userRoles.roleId, [...roleIds]))
    .groupBy(userRoles.roleId)

  return new Map(rows.map((row) => [row.roleId, row.total]))
}

export async function keyTaken(handle: DatabaseHandle, key: string): Promise<boolean> {
  const [row] = await handle.select({ id: roles.id }).from(roles).where(eq(roles.key, key)).limit(1)
  return row !== undefined
}

export async function insertRole(
  handle: DatabaseHandle,
  values: { key: string; name: string; description: string | null },
): Promise<string> {
  const [created] = await handle
    .insert(roles)
    .values({ ...values, isSystem: false })
    .returning({ id: roles.id })

  if (!created) throw new Error('the role could not be created')
  return created.id
}

/** Delete-then-write, for the same reason as `replaceUserRoles()` in `users.repo.ts`. */
export async function replaceRolePermissions(
  handle: DatabaseHandle,
  roleId: string,
  keys: readonly PermissionKey[],
): Promise<void> {
  await handle.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId))
  if (keys.length === 0) return

  await handle
    .insert(rolePermissions)
    .values(keys.map((permissionKey) => ({ roleId, permissionKey })))
    .onConflictDoNothing()
}
