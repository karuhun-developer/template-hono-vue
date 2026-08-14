import { PERMISSIONS, SYSTEM_ROLES, resolveRolePermissions } from '@app/contract'
import { eq, notInArray, sql } from 'drizzle-orm'

import type { Database } from '#db/client'
import { permissions, rolePermissions, roles } from '#db/schema'

/**
 * Provisioning: writing the permission catalog into the database, and cloning the system
 * roles.
 *
 * This is called by the seeder, and it is what a first-run bootstrap should call too. Keep
 * one implementation: the moment two callers each have their own copy, a demo installation
 * and a real one drift apart, and a bug that shows up in production stops being
 * reproducible locally.
 */

export type PermissionSyncResult = {
  total: number
  /** Keys still in the database that are no longer in the code catalog. */
  orphaned: string[]
}

/**
 * Bring the `permissions` table in line with the catalog in `@app/contract`.
 *
 * A key that has vanished from the catalog is **not deleted**, only reported. Deleting it
 * would take `role_permissions` down with it through the cascade — so one typo while
 * renaming a permission could strip access from everybody at once, with no way back short
 * of a restore. Clean-up is done deliberately, in a migration.
 */
export async function syncPermissionCatalog(database: Database): Promise<PermissionSyncResult> {
  await database
    .insert(permissions)
    .values(PERMISSIONS.map((p) => ({ key: p.key, group: p.group, label: p.label })))
    .onConflictDoUpdate({
      target: permissions.key,
      set: {
        // `group` is a SQL keyword, so it has to be quoted.
        group: sql`excluded."group"`,
        label: sql`excluded.label`,
        updatedAt: new Date(),
      },
    })

  const stale = await database
    .select({ key: permissions.key })
    .from(permissions)
    .where(
      notInArray(
        permissions.key,
        PERMISSIONS.map((p) => p.key),
      ),
    )

  return { total: PERMISSIONS.length, orphaned: stale.map((row) => row.key) }
}

/**
 * Clone the system roles. Idempotent: a role that already exists is **left alone**.
 *
 * That is deliberate. Once somebody has re-ticked their own permission matrix, that is
 * their decision — running the seeder again must not quietly put it back to the default.
 * Only roles that genuinely do not exist yet get created.
 */
export async function provisionSystemRoles(database: Database): Promise<{ created: string[] }> {
  const existing = await database
    .select({ key: roles.key, id: roles.id, isSystem: roles.isSystem })
    .from(roles)
  const existingKeys = new Set(existing.map((row) => row.key))

  await topUpWildcardRoles(database, existing)

  const created: string[] = []

  for (const template of SYSTEM_ROLES) {
    if (existingKeys.has(template.key)) continue

    const [role] = await database
      .insert(roles)
      .values({
        key: template.key,
        name: template.name,
        description: template.description,
        isSystem: true,
      })
      .returning({ id: roles.id })

    if (!role) continue

    await database.insert(rolePermissions).values(
      resolveRolePermissions(template).map((key) => ({
        roleId: role.id,
        permissionKey: key,
      })),
    )

    created.push(template.key)
  }

  return { created }
}

/**
 * Top up any role whose template is `'*'` — in practice, the owner.
 *
 * `'*'` has already promised "the whole catalog, including whatever gets added later", and
 * that promise cannot be kept by `role_permissions` rows frozen at install time: a
 * permission you add next month would never reach the owner who set the system up today,
 * and the symptom is a 403 on a screen that is plainly theirs.
 *
 * It applies only to roles that are **still** `is_system`. Once somebody edits the matrix
 * themselves, the role stops being a default and must not be added to behind their back.
 */
async function topUpWildcardRoles(
  database: Database,
  existing: readonly { key: string; id: string; isSystem: boolean }[],
): Promise<void> {
  const wildcardKeys = new Set<string>(
    SYSTEM_ROLES.filter((template) => template.permissions === '*').map((t) => t.key),
  )

  const targets = existing.filter((role) => role.isSystem && wildcardKeys.has(role.key))
  if (targets.length === 0) return

  await database
    .insert(rolePermissions)
    .values(
      targets.flatMap((role) =>
        PERMISSIONS.map((permission) => ({
          roleId: role.id,
          permissionKey: permission.key,
        })),
      ),
    )
    .onConflictDoNothing()
}

/** Used by the seeder to check whether a role exists before granting it. */
export async function findRoleByKey(
  database: Database,
  key: string,
): Promise<{ id: string } | null> {
  const [role] = await database
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.key, key))
    .limit(1)

  return role ?? null
}
