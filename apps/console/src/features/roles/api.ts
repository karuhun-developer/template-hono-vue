import type { InferResponseType } from 'hono/client'

import { listResult, type ResourceQuery, type ResourceResult } from '@/composables/useResourceList'
import { api } from '@/lib/api'
import { readAction, readApiError, type ActionResult, type ApiFailure } from '@/lib/api-error'

/**
 * Everything this console knows about roles: the shapes, and the calls.
 *
 * Derived from `AppType`, never declared — the same rule as `features/users/api.ts`, and for
 * the same reason: a field that leaves the API should break the component that showed it.
 */

export type RoleSummary = InferResponseType<typeof api.roles.$get>['items'][number]

/**
 * The catalog *and* what the caller holds, in one type — because that is how the endpoint
 * answers, and because the role matrix cannot be rendered correctly from either half alone:
 * the first decides the rows, the second decides which ticks may be touched.
 */
export type PermissionCatalog = InferResponseType<typeof api.roles.permissions.$get>

/** The keys `listRolesQuery` accepts as `?sort=`. Anything else falls back to the default. */
export const ROLE_SORTABLE = ['name', 'key', 'usedBy'] as const

export type RoleSortKey = (typeof ROLE_SORTABLE)[number]

/** No `q`: the endpoint has no search, so the table renders no search box either. */
export function fetchRoles(
  query: ResourceQuery<RoleSortKey>,
): Promise<ResourceResult<RoleSummary>> {
  return listResult(
    api.roles.$get(
      {
        query: {
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
 * The whole role list in one call, for the screens that draw checkboxes rather than a page.
 *
 * `perPage=100` is the ceiling `listRolesQuery` enforces. Past a hundred roles this control
 * has to become a picker with a search box — see `docs/features/rbac.md`.
 *
 * Returns an empty list rather than a failure on purpose: somebody holding `user.read`
 * without `role.read` may still look at the user list, they simply cannot change anyone's
 * roles — and that button is already hidden.
 */
export async function fetchRoleOptions(): Promise<RoleSummary[]> {
  try {
    const response = await api.roles.$get({ query: { perPage: '100' } })
    if (!response.ok) return []
    return (await response.json()).items
  } catch {
    return []
  }
}

/**
 * The permission catalog, which every role dialog needs and which never changes between
 * pages — it is the application's own list of what can be granted, fixed at build time.
 */
export async function fetchPermissionCatalog(): Promise<
  PermissionCatalog | { failure: ApiFailure }
> {
  const response = await api.roles.permissions.$get()
  if (!response.ok) return { failure: await readApiError(response) }
  return response.json()
}

export function createRole(input: {
  name: string
  description: string
  permissions: string[]
}): Promise<ActionResult<InferResponseType<typeof api.roles.$post>>> {
  return readAction(() => api.roles.$post({ json: input }))
}

export function updateRole(
  id: string,
  input: { name: string; description: string; permissions?: string[] },
): Promise<ActionResult<InferResponseType<(typeof api.roles)[':id']['$patch']>>> {
  return readAction(() => api.roles[':id'].$patch({ param: { id }, json: input }))
}

export function deleteRole(
  id: string,
): Promise<ActionResult<InferResponseType<(typeof api.roles)[':id']['$delete']>>> {
  return readAction(() => api.roles[':id'].$delete({ param: { id } }))
}
