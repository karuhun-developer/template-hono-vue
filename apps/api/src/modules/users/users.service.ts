import type { PermissionKey } from '@app/contract'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import { db, type DatabaseHandle } from '#db/client'
import { roles as rolesTable, users } from '#db/schema'
import { transaction } from '#db/tx'
import { badRequest, conflict, forbidden, notFound } from '#lib/errors'
import { hashPassword } from '#lib/password'
import { issueToken } from '#lib/token'
import { queueMail, revealTokens } from '#mail/outbox'
import { diffFields, recordAudit, type AuditActor } from '#modules/audit/audit.repo'
import { forgetAccess, loadAccess, type AccessContext } from '#modules/rbac/rbac.repo'
import { loadRolePermissions } from '#modules/roles/roles.repo'
import { assertGrantable } from '#modules/roles/roles.service'
import {
  findByEmail,
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
import { issueReset } from '#platform/password-reset.repo'

/**
 * The rules around managing people.
 *
 * Three of them cannot be expressed by a query builder, and two exist to stop somebody
 * promoting themselves:
 *
 * 1. **Which roles may be handed out.** Nobody can give away a permission they do not hold
 *    — otherwise `user.invite` quietly means "may become owner": create an account, give
 *    it the Owner role, sign in as it.
 * 2. **Nobody can disable or delete themselves.** The button that would undo it is behind
 *    the access they just took away from themselves — and, as a consequence, an
 *    installation can never be left without an account able to manage users.
 * 3. **Nobody can reset the password of an account stronger than their own.** Rule 1 by
 *    another route: taking over an account is a way of holding its permissions, and a reset
 *    link is a way of taking one over.
 */

/**
 * How long an invitation lives. Three days: long enough to survive a weekend, short enough
 * that a link left sitting in a chat history does not work forever. Anyone who misses it
 * asks for a new one, and re-sending kills the old link.
 */
const INVITE_TTL_HOURS = 72

export type InviteResult = {
  user: UserWithRoles
  /**
   * The link, for the caller — but only when nothing was really delivered.
   *
   * `revealTokens()` decides: under `MAIL_DRIVER=log` this is the token, once, and what is
   * stored is only a hash of it; under any real transport it is `null`, because the person
   * it belongs to has already been sent it.
   *
   * `string | null` rather than an optional field, deliberately. A key that comes and goes
   * makes the response an anonymous union, and the console derives its types from this
   * shape — one nullable field is a type it can hold, two shapes is not.
   */
  inviteToken: string | null
  inviteExpiresAt: Date
}

export type PasswordResetResult = {
  user: UserWithRoles
  /** Same rule as `inviteToken`, decided by the same `revealTokens()`. */
  resetToken: string | null
  resetExpiresAt: Date
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
    includeDeleted: query.includeDeleted,
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
 *
 * Soft-deleted accounts are included, because `?includeDeleted=true` puts them in the list
 * and a row the list just showed must not 404 when it is opened. The `deletedAt` field says
 * which kind of row this is.
 */
export async function getUser(userId: string): Promise<UserWithRoles> {
  const user = await findUser(db, userId, { includeDeleted: true })
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

  await assertEmailAvailable(body.email)

  /**
   * Hashed **before** the transaction opens. Argon2id is deliberately ~50 ms of CPU, and
   * holding a pooled connection open across it is a connection nobody else can have for no
   * reason at all — nothing in the hash depends on anything the transaction reads.
   */
  const passwordHash = await hashPassword(body.password)

  return transaction(async (tx, defer) => {
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

    // A brand-new id cannot have a cached permission set, so this drops nothing today. It is
    // here so that **every** write path in this file ends the same way: the matrix in
    // `docs/features/cache.md` is only trustworthy if it does not have exceptions a reader
    // has to hold in their head, and "empty by construction" is a property one future commit
    // can quietly change.
    defer('forget-access', () => forgetAccess(saved.id))

    return saved
  })
}

export async function inviteUser(
  access: AccessContext,
  actor: AuditActor,
  body: InviteUserBody,
): Promise<InviteResult> {
  await assertRolesGrantable(access, body.roleIds)

  await assertEmailAvailable(body.email)

  const invite = newInvite()

  return transaction(async (tx, defer) => {
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

    // Same reasoning as `createUser`: nothing can be cached under an id this transaction
    // has just invented, and the list of write paths is worth more than the line it costs.
    defer('forget-access', () => forgetAccess(saved.id))

    // Inside the transaction, so an invitation that rolls back — a duplicate address, a
    // role that turned out not to exist — takes its email down with it. Nobody is invited
    // to an account that was never created.
    await queueMail(tx, defer, {
      to: { email: saved.email, name: saved.name },
      template: 'invitation',
      payload: {
        name: saved.name,
        token: invite.token,
        expiresAt: invite.expiresAt.toISOString(),
      },
    })

    return { user: saved, inviteToken: reveal(invite.token), inviteExpiresAt: invite.expiresAt }
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

  return transaction(async (tx, defer) => {
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

    await queueMail(tx, defer, {
      to: { email: saved.email, name: saved.name },
      template: 'invitation',
      payload: {
        name: saved.name,
        token: invite.token,
        expiresAt: invite.expiresAt.toISOString(),
      },
    })

    return { user: saved, inviteToken: reveal(invite.token), inviteExpiresAt: invite.expiresAt }
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

  return transaction(async (tx, defer) => {
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

    // The entry that actually matters. This is the route the console's role editor uses, so
    // it is the one that decides whether "I took that permission away" is true on the very
    // next request or true in thirty seconds.
    defer('forget-access', () => forgetAccess(userId))

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

  return transaction(async (tx, defer) => {
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

    // Status is not part of a permission set — a disabled account is turned away one layer
    // earlier, by the `status = 'active'` join in `findLiveSession`. Dropped anyway, for the
    // reason `createUser` gives: a matrix with exceptions is a matrix nobody trusts.
    defer('forget-access', () => forgetAccess(userId))

    const saved = await findUser(tx, userId)
    if (!saved) throw new Error('the user could not be read back')
    return saved
  })
}

/**
 * Soft-delete an account.
 *
 * Soft only, and there is no hard delete anywhere in this module. Old audit entries name
 * people who have left, and `user_roles.role_id` is `ON DELETE RESTRICT` on purpose — a row
 * that vanishes takes its history's meaning with it. When a row may truly go is a retention
 * policy your project writes, not one a starter answers for you.
 *
 * Like disabling, this sweeps **no sessions**. `findLiveSession()` already joins
 * `deleted_at IS NULL`, so the next request a deleted person makes finds nothing and gets a
 * `401`. A second mechanism doing the same job is how the first stops being trusted.
 */
export async function deleteUser(
  access: AccessContext,
  actor: AuditActor,
  userId: string,
): Promise<UserWithRoles> {
  const target = await findUser(db, userId, { includeDeleted: true })
  if (!target) throw notFound('User not found.')

  if (userId === access.userId) {
    // The same reasoning as self-disable: the endpoint that would undo it is behind the
    // access just removed.
    //
    // This one refusal is also what keeps an installation repairable. Whoever reaches this
    // route holds `user.delete` and is signed in, so they are themselves a live holder of
    // it — which means deleting *somebody else* can never remove the last account able to
    // manage users. A separate "is this the last manager" count would read as protection
    // while being unreachable, and an unreachable guard is a comfort, not a safeguard.
    throw badRequest('You cannot delete your own account.')
  }

  // Already gone. Answering with the row rather than an error matches `setUserStatus`,
  // which returns early when the status already is what was asked for: a repeated request
  // that changes nothing is not a failure.
  if (target.deletedAt) return target

  return transaction(async (tx, defer) => {
    await tx
      .update(users)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))

    await recordAudit(tx, actor, {
      action: 'user.delete',
      subjectType: 'users',
      subjectId: target.id,
      subjectLabel: target.email,
      before: { status: target.status, deletedAt: null },
      after: { status: target.status, deleted: true },
    })

    defer('forget-access', () => forgetAccess(userId))

    const saved = await findUser(tx, userId, { includeDeleted: true })
    if (!saved) throw new Error('the user could not be read back')
    return saved
  })
}

/**
 * Undo a soft delete.
 *
 * Nothing has to be reserved for this to work: `users_email_key` deliberately has **no**
 * `deleted_at` predicate, so the address stayed taken the whole time and cannot have been
 * handed to somebody else in the meantime. That is also why re-inviting a deleted address
 * is a `409` pointing here rather than a second account — `audit_logs.actor_label` stores
 * the email as it read at the time, so a new account on an old address would inherit a
 * departed person's trail.
 *
 * The status the account had is the status it comes back with. A disabled person who is
 * deleted and restored is still disabled; restoring is not a way to skip a decision.
 */
export async function restoreUser(actor: AuditActor, userId: string): Promise<UserWithRoles> {
  const target = await findUser(db, userId, { includeDeleted: true })
  if (!target) throw notFound('User not found.')

  if (!target.deletedAt) return target

  return transaction(async (tx, defer) => {
    await tx
      .update(users)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(users.id, userId))

    await recordAudit(tx, actor, {
      action: 'user.restore',
      subjectType: 'users',
      subjectId: target.id,
      subjectLabel: target.email,
      before: { deleted: true },
      after: { deleted: false, status: target.status },
    })

    defer('forget-access', () => forgetAccess(userId))

    const saved = await findUser(tx, userId)
    if (!saved) throw new Error('the user could not be read back')
    return saved
  })
}

/**
 * Start a password reset on somebody else's behalf.
 *
 * The counterpart to `POST /auth/forgot-password`, for the person who cannot receive the
 * mail — a changed address, a mailbox nobody has access to any more. Both ends issue the
 * same kind of token through the same repository; what differs is who is asking.
 *
 * Three differences from the self-service door, each deliberate:
 *
 * - **No cooldown.** It exists to stop an anonymous form being used as an email cannon.
 *   Whoever reaches this route is signed in, holds an owner-only permission, and is named
 *   in the audit entry — pressing the button twice is not an attack.
 * - **The token can come back in the response**, once, exactly as an invitation token does —
 *   but only under `MAIL_DRIVER=log`, where nothing was really delivered. See
 *   `revealTokens()`.
 * - **The reasons are specific.** An invited or disabled account gets told which it is;
 *   there is nothing to leak to a caller who can already read the user list.
 */
export async function triggerPasswordReset(
  access: AccessContext,
  actor: AuditActor,
  userId: string,
): Promise<PasswordResetResult> {
  const target = await findUser(db, userId)
  if (!target) throw notFound('User not found.')

  if (target.status !== 'active') {
    throw badRequest(
      target.status === 'invited'
        ? 'This account has never set a password — re-send its invitation instead.'
        : 'This account is disabled. Enable it before resetting its password.',
    )
  }

  await assertNotStronger(access, userId)

  return transaction(async (tx, defer) => {
    const issued = await issueReset(tx, userId)
    // Only an account that is active and not deleted can be reset, and both were just
    // checked through `findUser`. Nothing else can make this null.
    if (!issued) throw new Error('the password reset could not be issued')

    await recordAudit(tx, actor, {
      action: 'user.password_reset_request',
      subjectType: 'users',
      subjectId: target.id,
      subjectLabel: target.email,
    })

    const saved = await findUser(tx, userId)
    if (!saved) throw new Error('the user could not be read back')

    // `triggeredByAdmin`, so the mail can say why it arrived. Somebody who did not ask for
    // a reset needs to be able to tell "an administrator did this" from "somebody is trying
    // to take my account", and those two need different closing sentences.
    await queueMail(tx, defer, {
      to: { email: saved.email, name: saved.name },
      template: 'password-reset',
      payload: {
        name: saved.name,
        token: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        triggeredByAdmin: true,
      },
    })

    return { user: saved, resetToken: reveal(issued.token), resetExpiresAt: issued.expiresAt }
  })
}

// --- Guards -----------------------------------------------------------------

/**
 * May the caller take this account over?
 *
 * Because that is what a reset link is. Without this check, `user.reset_password` handed to
 * a support role means "may become owner" by a slightly longer path than rule 1's: reset the
 * owner's password, follow the link, sign in. The same escalation, the same refusal.
 *
 * It compares **effective permissions**, not roles: what matters is what the target account
 * can do, however it came by it.
 */
async function assertNotStronger(access: AccessContext, targetId: string): Promise<void> {
  const target = await loadAccess(targetId)
  const excess = [...target.permissions].filter((key) => !access.permissions.has(key)).sort()

  if (excess.length > 0) {
    throw forbidden('You cannot reset the password of an account more powerful than your own.', {
      permissions: excess,
    })
  }
}

/**
 * Is this address free to hand to a new account?
 *
 * Two answers, because they need different words. An address in use belongs to somebody who
 * is here; an address on a soft-deleted row belongs to somebody who left, and the thing to
 * do with it is restore that account rather than create a second one on the same address.
 *
 * A specific message is fine on both: whoever is asking is already inside the application
 * and entitled to know who else is. The endpoint that has to stay vague is the sign-in one.
 */
async function assertEmailAvailable(address: string): Promise<void> {
  const existing = await findByEmail(db, address)
  if (!existing) return

  if (existing.deletedAt) {
    throw conflict('That email address belongs to a deleted account. Restore it instead.')
  }

  throw conflict('That email address already belongs to someone here.')
}

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

/**
 * The token for the caller, or nothing at all.
 *
 * One line, so that "when may a link be handed back" is answered in one place —
 * `revealTokens()` — rather than in three call sites that can drift apart. The mail is
 * queued either way; this only decides whether the response carries a second copy.
 */
function reveal(token: string): string | null {
  return revealTokens() ? token : null
}

function newInvite(): { token: string; tokenHash: string; expiresAt: Date } {
  const { token, tokenHash } = issueToken('invite')
  return { token, tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000) }
}

/** Roles in a form worth reading in the audit log — raw ids explain nothing. */
function describe(user: UserWithRoles): string[] {
  return user.roles.map((role) => role.roleKey).sort()
}
