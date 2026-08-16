import { useResourceList, type UseResourceList } from '@/composables/useResourceList'
import { fetchRoles, ROLE_SORTABLE, type RoleSortKey, type RoleSummary } from '@/features/roles/api'

/**
 * The roles list, ready to hand to `RolesTable`.
 *
 * No search and no facets: the endpoint offers neither, and a search box that filters
 * nothing is worse than none at all.
 */

export type UseRolesList = UseResourceList<RoleSummary, RoleSortKey>

export function useRolesList(): UseRolesList {
  return useResourceList<RoleSummary, RoleSortKey>({
    sortable: ROLE_SORTABLE,
    defaultSort: { key: 'name', order: 'asc' },
    fetch: fetchRoles,
  })
}
