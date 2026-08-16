import type { PermissionKey } from '@app/contract'
import type { InferResponseType } from 'hono/client'

import { listResult, type ResourceQuery, type ResourceResult } from '@/composables/useResourceList'
import { api } from '@/lib/api'
import { readAction, type ActionResult } from '@/lib/api-error'

/**
 * Everything this console knows about users: the shapes, and the calls.
 *
 * Not one type here is written by hand — every one is read out of `AppType`. A column that
 * disappears from the API becomes a TypeScript error in the component that showed it,
 * rather than an `undefined` somebody notices on screen a week later.
 *
 * Keeping the calls here too means there is exactly one place that knows the shape of the
 * users endpoints, so a page that only wants the edit dialog does not end up reaching into
 * `api.users` for itself.
 */

export type UserSummary = InferResponseType<typeof api.users.$get>['items'][number]
export type UserStatus = UserSummary['status']
export type UserRoleRef = UserSummary['roles'][number]

/** The keys `listUsersQuery` accepts as `?sort=`. Anything else falls back to the default. */
export const USER_SORTABLE = ['name', 'email', 'status', 'lastLoginAt', 'createdAt'] as const

export type UserFilters = {
  statuses: string[]
  roleIds: string[]
  /** Soft-deleted accounts are hidden unless this is asked for. */
  includeDeleted: boolean
}

export type UserSortKey = (typeof USER_SORTABLE)[number]

export function fetchUsers(
  query: ResourceQuery<UserSortKey>,
  filters: UserFilters,
): Promise<ResourceResult<UserSummary>> {
  return listResult(
    api.users.$get(
      {
        query: {
          ...(query.q === '' ? {} : { q: query.q }),
          // Sent once per ticked box; the API reads a repeated parameter as a set.
          ...(filters.statuses.length === 0 ? {} : { status: filters.statuses as UserStatus[] }),
          ...(filters.roleIds.length === 0 ? {} : { roleId: filters.roleIds }),
          // Spelled out as a string, because the API reads an enum of two words rather than
          // a coerced boolean — `"false"` would otherwise arrive meaning `true`.
          includeDeleted: filters.includeDeleted ? 'true' : 'false',
          page: String(query.page),
          perPage: String(query.perPage),
          sort: query.sort,
          order: query.order,
        },
      },
      { init: { signal: query.signal } },
    ),
  )
}

/**
 * What any of the three writes hands back.
 *
 * `inviteToken` is present only on the invite path — creating an account outright has no
 * link, because the password was chosen by whoever filled the form in — and it is `null`
 * whenever the API really emailed the invitation, which is every configuration except
 * `MAIL_DRIVER=log`. A token that is there is there once: the server keeps only a hash.
 */
export type UserSaved = {
  user: UserSummary
  inviteToken?: string | null
  inviteExpiresAt?: string
}

export function inviteUser(input: {
  email: string
  name: string
  roleIds: string[]
}): Promise<ActionResult<InferResponseType<typeof api.users.$post>>> {
  return readAction(() => api.users.$post({ json: input }))
}

/**
 * Its own call against its own route, because it is behind its own permission. Choosing
 * somebody else's password is a different act from mailing them a link, and the API keeps
 * the two apart rather than reading a mode out of one body.
 */
export function createUser(input: {
  email: string
  name: string
  password: string
  roleIds: string[]
}): Promise<ActionResult<InferResponseType<typeof api.users.create.$post>>> {
  return readAction(() => api.users.create.$post({ json: input }))
}

export function updateUser(
  id: string,
  input: { name: string; roleIds: string[] },
): Promise<ActionResult<InferResponseType<(typeof api.users)[':id']['$patch']>>> {
  // Roles are sent whole, never as a difference — see the note in `RolesEditor.vue`.
  return readAction(() => api.users[':id'].$patch({ param: { id }, json: input }))
}

export function resendInvite(
  id: string,
): Promise<ActionResult<InferResponseType<(typeof api.users)[':id']['invite']['$post']>>> {
  return readAction(() => api.users[':id'].invite.$post({ param: { id } }))
}

export function setUserStatus(
  id: string,
  status: 'active' | 'disabled',
): Promise<ActionResult<InferResponseType<(typeof api.users)[':id']['status']['$post']>>> {
  return readAction(() => api.users[':id'].status.$post({ param: { id }, json: { status } }))
}

export function deleteUser(
  id: string,
): Promise<ActionResult<InferResponseType<(typeof api.users)[':id']['$delete']>>> {
  return readAction(() => api.users[':id'].$delete({ param: { id } }))
}

export function restoreUser(
  id: string,
): Promise<ActionResult<InferResponseType<(typeof api.users)[':id']['restore']['$post']>>> {
  return readAction(() => api.users[':id'].restore.$post({ param: { id } }))
}

/**
 * Starts a reset on somebody else's account and hands back the link — once, the way an
 * invitation does, because the server keeps only its hash.
 */
export function resetUserPassword(
  id: string,
): Promise<ActionResult<InferResponseType<(typeof api.users)[':id']['reset-password']['$post']>>> {
  return readAction(() => api.users[':id']['reset-password'].$post({ param: { id } }))
}

/* ------------------------------------------------------------------------ dialog modes */

/**
 * Which of the three things the user dialog is doing.
 *
 * Pure, and here rather than inside the component, because it is the one piece of that
 * dialog worth a test: the branch decides which endpoint a submit reaches, and getting it
 * wrong sends an invitation to somebody who was meant to be created with a password.
 *
 * It is **not** a permission check. Nothing here refuses anything — `requirePermission()`
 * on each route does, and the 403 test beside it is what proves so. This only decides what
 * is worth offering.
 */
export type UserDialogMode = 'invite' | 'create' | 'edit'

const MODE_PERMISSION = {
  invite: 'user.invite',
  create: 'user.create',
  edit: 'user.update',
} as const satisfies Record<UserDialogMode, PermissionKey>

/**
 * The modes the caller may pick between, in the order they should be offered.
 *
 * An existing user is only ever edited. A new one can be invited, created outright, or —
 * for whoever holds both keys — either, and the dialog puts one footer button behind each.
 */
export function offeredModes(
  user: UserSummary | null,
  can: (permission: PermissionKey) => boolean,
): UserDialogMode[] {
  if (user !== null) return ['edit']
  return (['invite', 'create'] as const).filter((mode) => can(MODE_PERMISSION[mode]))
}

/**
 * Which button the Enter key presses.
 *
 * Invite wins when both are held: the account nobody else has ever known the password of
 * is the better default, and choosing one for somebody is the deliberate act — it is the
 * button you have to aim at.
 *
 * The fallback matters less than it looks — a caller holding neither key never sees the
 * button that opens this — but "invite" is the harmless half of the pair to land on.
 */
export function dialogMode(
  user: UserSummary | null,
  can: (permission: PermissionKey) => boolean,
): UserDialogMode {
  return offeredModes(user, can)[0] ?? 'invite'
}
