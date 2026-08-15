import type { PermissionKey } from '@app/contract'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import { db, type DatabaseHandle } from '#db/client'
import { roles as rolesTable, users } from '#db/schema'
import { badRequest, conflict, notFound } from '#lib/errors'
import { hashPassword } from '#lib/password'
import { issueToken } from '#lib/token'
import { diffFields, recordAudit, type AuditActor } from '#modules/audit/audit.repo'
import { type AccessContext } from '#modules/rbac/rbac.repo'
import { loadRolePermissions } from '#modules/roles/roles.repo'
import { assertGrantable } from '#modules/roles/roles.service'
import {
  emailTaken,
  findUser,
  listUsers,
  replaceUserRoles,
  type UserWithRoles,
} from '#modules/users/users.repo'
import type {
  CreateUserBody,
  InviteUserBody,
  ListUsersQuery,
  UpdateUserBody,
} from '#modules/users/users.schema'

/**
 * The rules around managing people.
 *
 * Two of them cannot be expressed by a query builder, and both exist to stop somebody
 * promoting themselves:
 *
 * 1. **Which roles may be handed out.** Nobody can give away a permission they do not hold
 *    — otherwise `user.invite` quietly means "may become owner": create an account, give
 *    it the Owner role, sign in as it.
 * 2. **Nobody can disable themselves.** The button that would undo it is behind the access
 *    they just took away from themselves.
 */

/**
 * How long an invitation lives. Three days: long enough to survive a weekend, short enough
 * that a link left sitting in a chat history does not work forever. Anyone who misses it
 * asks for a new one, and re-sending kills the old link.
 */
const INVITE_TTL_HOURS = 72

export type InviteResult = {
  user: UserWithRoles
  /** Returned once, in this response only. What is stored is a hash of it. */
  inviteToken: string
  inviteExpiresAt: Date
}

// --- Read -------------------------------------------------------------------

export type UserListPage = {
  items: UserWithRoles[]
  total: number
  page: number
  perPage: number
}

/**
 * The page is echoed back rather than left for the client to remember. It is the only way
 * a caller can tell that `?page=99` on a three-page list gave it nothing because it asked
 * past the end, and not because the filter matched nothing.
 */
export async function listVisibleUsers(query: ListUsersQuery): Promise<UserListPage> {
  const { rows, total } = await listUsers({
    status: query.status,
    q: query.q,
    roleId: query.roleId,
    page: query.page,
    perPage: query.perPage,
    sort: query.sort,
    order: query.order,
  })

  return { items: rows, total, page: query.page, perPage: query.perPage }
}

/**
 * One user, by id.
 *
 * Answers with the same shape a row in the list has, so a page that opens a record does not
 * have to reconcile two slightly different users. A `404` rather than an empty body: "no
 * such user" is not a successful read.
 */
export async function getUser(userId: string): Promise<UserWithRoles> {
  const user = await findUser(db, userId)
  if (!user) throw notFound('User not found.')
  return user
}

// --- Write ------------------------------------------------------------------

/**
 * Create an account outright, with a password set on the new person's behalf.
 *
 * The sibling of `inviteUser`, and it runs the same escalation guard first for the same
 * reason: without it `user.create` quietly means "may become owner". The two differ only in
 * how the account gets its first password — which is exactly why they are two permissions
 * and two routes.
 */
export async function createUser(
  access: AccessContext,
  actor: AuditActor,
  body: CreateUserBody,
): Promise<UserWithRoles> {
  await assertRolesGrantable(access, body.roleIds)

  if (await emailTaken(db, body.email)) {
    throw conflict('That email address already belongs to someone here.')
  }

  /**
   * Hashed **before** the transaction opens. Argon2id is deliberately ~50 ms of CPU, and
   * holding a pooled connection open across it is a connection nobody else can have for no
   * reason at all — nothing in the hash depends on anything the transaction reads.
   */
  const passwordHash = await hashPassword(body.password)

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({
        email: body.email,
        name: body.name,
        status: 'active',
        passwordHash,
      })
      .returning({ id: users.id })

    if (!created) throw new Error('the user could not be created')

    await replaceUserRoles(tx, created.id, body.roleIds)

    const saved = await findUser(tx, created.id)
    if (!saved) throw new Error('the new user could not be read back')

    await recordAudit(tx, actor, {
      action: 'user.create',
      subjectType: 'users',
      subjectId: saved.id,
      subjectLabel: saved.email,
      // No password material. `recordAudit` redacts those keys on the way in, and the way
      // to keep that guarantee true is to never hand it any in the first place.
      after: { email: saved.email, name: saved.name, roles: describe(saved) },
    })

    return saved
  })
}

export async function inviteUser(
  access: AccessContext,
  actor: AuditActor,
  body: InviteUserBody,
): Promise<InviteResult> {
  await assertRolesGrantable(access, body.roleIds)

  if (await emailTaken(db, body.email)) {
    // A specific message is fine here: whoever is asking is already inside the application
    // and entitled to know who else is. The endpoint that has to stay vague is the login
    // one, not this.
    throw conflict('That email address already belongs to someone here.')
  }

  const invite = newInvite()

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({
        email: body.email,
        name: body.name,
        status: 'invited',
        inviteTokenHash: invite.tokenHash,
        inviteExpiresAt: invite.expiresAt,
      })
      .returning({ id: users.id })

    if (!created) throw new Error('the user could not be created')

    await replaceUserRoles(tx, created.id, body.roleIds)

    const saved = await findUser(tx, created.id)
    if (!saved) throw new Error('the new user could not be read back')

    await recordAudit(tx, actor, {
      action: 'user.invite',
      subjectType: 'users',
      subjectId: saved.id,
      subjectLabel: saved.email,
      after: { email: saved.email, name: saved.name, roles: describe(saved) },
    })

    return { user: saved, inviteToken: invite.token, inviteExpiresAt: invite.expiresAt }
  })
}

/**
 * Re-send an invitation: the old token dies, a new one is born.
 *
 * A rotation, not a second issue. Leaving the old one alive means an invitation that ended
 * up in the wrong inbox can still be used by whoever holds it, with no way to call it back
 * short of deleting the account.
 */
export async function resendInvite(actor: AuditActor, userId: string): Promise<InviteResult> {
  const target = await findUser(db, userId)
  if (!target) throw notFound('User not found.')

  if (target.status !== 'invited') {
    throw badRequest('This account is already active — there is no invitation to re-send.')
  }

  const invite = newInvite()

  return db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        inviteTokenHash: invite.tokenHash,
        inviteExpiresAt: invite.expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))

    await recordAudit(tx, actor, {
      action: 'user.invite_resend',
      subjectType: 'users',
      subjectId: target.id,
      subjectLabel: target.email,
    })

    const saved = await findUser(tx, userId)
    if (!saved) throw new Error('the user could not be read back')

    return { user: saved, inviteToken: invite.token, inviteExpiresAt: invite.expiresAt }
  })
}

export async function updateUser(
  access: AccessContext,
  actor: AuditActor,
  userId: string,
  body: UpdateUserBody,
): Promise<UserWithRoles> {
  const target = await findUser(db, userId)
  if (!target) throw notFound('User not found.')

  if (body.roleIds) await assertRolesGrantable(access, body.roleIds)

  return db.transaction(async (tx) => {
    if (body.name !== undefined) {
      await tx
        .update(users)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(users.id, userId))
    }

    if (body.roleIds) await replaceUserRoles(tx, userId, body.roleIds)

    const saved = await findUser(tx, userId)
    if (!saved) throw new Error('the user could not be read back')

    const changes = diffFields(
      { name: target.name, roles: describe(target) },
      { name: saved.name, roles: describe(saved) },
    )

    if (changes) {
      await recordAudit(tx, actor, {
        action: 'user.update',
        subjectType: 'users',
        subjectId: saved.id,
        subjectLabel: saved.email,
        before: changes.before,
        after: changes.after,
      })
    }

    return saved
  })
}

/**
 * Enable or disable an account.
 *
 * Disabling does not sweep the person's sessions: every session lookup joins `users` with
 * `status = 'active'`, so their **next request** finds no live session and they are signed
 * out. One condition in SQL beats a revocation pass that can be forgotten.
 */
export async function setUserStatus(
  access: AccessContext,
  actor: AuditActor,
  userId: string,
  status: 'active' | 'disabled',
): Promise<UserWithRoles> {
  const target = await findUser(db, userId)
  if (!target) throw notFound('User not found.')

  if (userId === access.userId) {
    throw badRequest('You cannot disable your own account.')
  }

  if (target.status === status) return target

  if (status === 'active' && target.status === 'invited') {
    throw badRequest('This invitation has not been accepted yet — re-send it instead.')
  }

  return db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))

    await recordAudit(tx, actor, {
      action: status === 'disabled' ? 'user.disable' : 'user.enable',
      subjectType: 'users',
      subjectId: target.id,
      subjectLabel: target.email,
      before: { status: target.status },
      after: { status },
    })

    const saved = await findUser(tx, userId)
    if (!saved) throw new Error('the user could not be read back')
    return saved
  })
}

// --- Guards -----------------------------------------------------------------

/**
 * May the caller hand out these roles?
 *
 * The same rule as editing a role's permissions, applied from the other side — which is
 * why `assertGrantable` is imported rather than copied. Leave one of the two out and the
 * other becomes a way around it.
 */
async function assertRolesGrantable(
  access: AccessContext,
  roleIds: readonly string[],
): Promise<void> {
  const found = await loadRoles(db, roleIds)

  for (const roleId of roleIds) {
    const role = found.get(roleId)
    if (!role) throw badRequest('One of the selected roles does not exist.')

    assertGrantable(access, role.permissions)
  }
}

async function loadRoles(
  handle: DatabaseHandle,
  roleIds: readonly string[],
): Promise<Map<string, { id: string; name: string; permissions: PermissionKey[] }>> {
  if (roleIds.length === 0) return new Map()

  const rows = await handle
    .select({ id: rolesTable.id, name: rolesTable.name })
    .from(rolesTable)
    .where(inArray(rolesTable.id, [...roleIds]))

  const permissions = await loadRolePermissions(
    handle,
    rows.map((row) => row.id),
  )

  return new Map(
    rows.map((row) => [row.id, { ...row, permissions: permissions.get(row.id) ?? [] }]),
  )
}

function newInvite(): { token: string; tokenHash: string; expiresAt: Date } {
  const { token, tokenHash } = issueToken('invite')
  return { token, tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000) }
}

/** Roles in a form worth reading in the audit log — raw ids explain nothing. */
function describe(user: UserWithRoles): string[] {
  return user.roles.map((role) => role.roleKey).sort()
}
