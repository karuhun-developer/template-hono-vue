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
 * What either write hands back.
 *
 * `inviteToken` exists only on the invite path, and only for as long as the response
 * carries it — the server keeps a hash, so this is the single moment it can be read.
 */
export type UserSaved = {
  user: UserSummary
  inviteToken?: string
  inviteExpiresAt?: string
}

export function inviteUser(input: {
  email: string
  name: string
  roleIds: string[]
}): Promise<ActionResult<InferResponseType<typeof api.users.$post>>> {
  return readAction(() => api.users.$post({ json: input }))
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
