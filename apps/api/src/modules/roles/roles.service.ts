import { PERMISSIONS, type PermissionGroup, type PermissionKey } from '@app/contract'
import { eq } from 'drizzle-orm'

import { db } from '#db/client'
import { roles } from '#db/schema'
import { badRequest, conflict, forbidden, notFound } from '#lib/errors'
import { diffFields, recordAudit, type AuditActor } from '#modules/audit/audit.repo'
import { allPermissions, type AccessContext } from '#modules/rbac/rbac.repo'
import {
  findRole,
  insertRole,
  keyTaken,
  replaceRolePermissions,
  type RoleWithPermissions,
} from '#modules/roles/roles.repo'
import type { CreateRoleBody, UpdateRoleBody } from '#modules/roles/roles.schema'

/**
 * The rules around roles.
 *
 * One rule holds the whole file together, and it is the same one that governs which roles
 * a person may hand out: **nobody can write a permission they do not hold themselves.**
 * Without it, `role.manage` is a detour to the entire catalog — invent a role called
 * "Assistant" holding everything, give it to yourself, done.
 *
 * It has two directions, and missing the second one is the usual mistake:
 *
 * 1. You cannot **add** a permission you do not hold (`assertGrantable`).
 * 2. You cannot **remove** one you do not hold either (`removedBeyondReach`). The console
 *    renders those ticks disabled; a payload that drops them is a client ignoring that,
 *    and the effect would be an admin quietly stripping `audit.read` from the owner role.
 *
 * System roles (`is_system`) can be edited but not deleted. Deleting one takes away
 * everybody's access at once, and there is no obvious way back from there.
 */

export type PermissionCatalog = {
  groups: { key: PermissionGroup; permissions: { key: PermissionKey; label: string }[] }[]
  /** What the caller holds — what decides which ticks they are allowed to touch. */
  granted: PermissionKey[]
}

export function permissionCatalog(access: AccessContext): PermissionCatalog {
  const byGroup = new Map<PermissionGroup, { key: PermissionKey; label: string }[]>()

  for (const permission of PERMISSIONS) {
    const bucket = byGroup.get(permission.group) ?? []
    bucket.push({ key: permission.key, label: permission.label })
    byGroup.set(permission.group, bucket)
  }

  return {
    // Catalog order, not alphabetical: `PERMISSIONS` is already arranged from what people
    // look for most often to what they look for least.
    groups: [...byGroup].map(([key, permissions]) => ({ key, permissions })),
    granted: allPermissions(access),
  }
}

export async function createRole(
  access: AccessContext,
  actor: AuditActor,
  body: CreateRoleBody,
): Promise<RoleWithPermissions> {
  const wanted = body.permissions as PermissionKey[]
  assertGrantable(access, wanted)

  const key = await uniqueKey(slugify(body.name))

  return db.transaction(async (tx) => {
    const id = await insertRole(tx, {
      key,
      name: body.name,
      description: body.description ?? null,
    })

    await replaceRolePermissions(tx, id, wanted)

    const saved = await findRole(tx, id)
    if (!saved) throw new Error('the new role could not be read back')

    await recordAudit(tx, actor, {
      action: 'role.create',
      subjectType: 'roles',
      subjectId: id,
      subjectLabel: saved.name,
      after: { key: saved.key, permissions: saved.permissions },
    })

    return saved
  })
}

export async function updateRole(
  access: AccessContext,
  actor: AuditActor,
  roleId: string,
  body: UpdateRoleBody,
): Promise<RoleWithPermissions> {
  const before = await findRole(db, roleId)
  if (!before) throw notFound('Role not found.')

  if (body.permissions) {
    const wanted = body.permissions as PermissionKey[]
    assertGrantable(access, wanted)

    const mine = allPermissions(access)
    const removedBeyondReach = before.permissions.filter(
      (key) => !wanted.includes(key) && !mine.includes(key),
    )

    if (removedBeyondReach.length > 0) {
      throw forbidden('This role holds permissions you do not have, so you cannot change it.', {
        permissions: removedBeyondReach,
      })
    }
  }

  return db.transaction(async (tx) => {
    const profile: { name?: string; description?: string | null } = {}
    if (body.name !== undefined) profile.name = body.name
    if (body.description !== undefined) profile.description = body.description

    if (Object.keys(profile).length > 0) {
      await tx
        .update(roles)
        .set({ ...profile, updatedAt: new Date() })
        .where(eq(roles.id, roleId))
    }

    if (body.permissions) {
      await replaceRolePermissions(tx, roleId, body.permissions as PermissionKey[])
    }

    const saved = await findRole(tx, roleId)
    if (!saved) throw new Error('the role could not be read back')

    const changes = diffFields(
      { name: before.name, description: before.description, permissions: before.permissions },
      { name: saved.name, description: saved.description, permissions: saved.permissions },
    )

    // A save that changed nothing leaves no audit row. A log full of "nothing changed" is
    // a log people stop reading, and that is the dangerous part.
    if (changes) {
      await recordAudit(tx, actor, {
        action: 'role.update',
        subjectType: 'roles',
        subjectId: roleId,
        subjectLabel: saved.name,
        before: changes.before,
        after: changes.after,
      })
    }

    return saved
  })
}

export async function deleteRole(actor: AuditActor, roleId: string): Promise<void> {
  const role = await findRole(db, roleId)
  if (!role) throw notFound('Role not found.')

  if (role.isSystem) {
    throw badRequest(
      `"${role.name}" is a built-in role. Its permissions can be edited, but the role itself cannot be deleted.`,
    )
  }

  // `user_roles.role_id` is ON DELETE RESTRICT, so the database would refuse this anyway.
  // The check exists so that the answer is a sentence rather than a constraint violation —
  // and moving people off the role first is a decision somebody should have to look at.
  if (role.usedBy > 0) {
    throw conflict(
      `This role is still held by ${role.usedBy} ${role.usedBy === 1 ? 'user' : 'users'}. Move them to another role first.`,
    )
  }

  await db.transaction(async (tx) => {
    await tx.delete(roles).where(eq(roles.id, roleId))

    await recordAudit(tx, actor, {
      action: 'role.delete',
      subjectType: 'roles',
      subjectId: roleId,
      subjectLabel: role.name,
      before: { key: role.key, permissions: role.permissions },
    })
  })
}

// --- Guards and helpers -----------------------------------------------------

export function assertGrantable(access: AccessContext, wanted: readonly PermissionKey[]): void {
  const mine = new Set(allPermissions(access))
  const excess = wanted.filter((key) => !mine.has(key))

  if (excess.length > 0) {
    throw forbidden('You cannot grant permissions you do not hold yourself.', {
      permissions: excess,
    })
  }
}

/**
 * The `key` is derived from the name rather than typed.
 *
 * It is used from code (`SYSTEM_ROLES`, the seeder), so its shape has to be guaranteed. A
 * name can then be edited freely without breaking anything, because the key does not
 * change once the role exists.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

  return slug === '' ? 'role' : slug
}

async function uniqueKey(base: string): Promise<string> {
  if (!(await keyTaken(db, base))) return base

  for (let suffix = 2; suffix <= 50; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!(await keyTaken(db, candidate))) return candidate
  }

  throw conflict('Too many roles with a similar name. Use something more specific.')
}
