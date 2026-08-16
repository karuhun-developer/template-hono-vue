import { ref, type Ref } from 'vue'

import { useResourceList, type UseResourceList } from '@/composables/useResourceList'
import { fetchUsers, USER_SORTABLE, type UserSortKey, type UserSummary } from '@/features/users/api'

/**
 * The users list, ready to hand to `UsersTable`.
 *
 * The three faceted filters are declared here rather than inside `useResourceList` because
 * they are specific to this endpoint: the composable only needs to know that they exist,
 * so that changing one resets the page and clears with Reset.
 */

export type UseUsersList = UseResourceList<UserSummary, UserSortKey> & {
  statuses: Ref<string[]>
  roleIds: Ref<string[]>
  /**
   * A facet, rather than the boolean the API takes, and deliberately so: `useResourceList`
   * watches `Ref<string[]>` filters, so declaring it this way is what makes "show the
   * deleted rows" reset the page and clear with Reset like every other narrowing does.
   * Anything ticked means `includeDeleted=true`.
   */
  deleted: Ref<string[]>
}

export function useUsersList(): UseUsersList {
  const statuses = ref<string[]>([])
  const roleIds = ref<string[]>([])
  const deleted = ref<string[]>([])

  const list = useResourceList<UserSummary, UserSortKey>({
    sortable: USER_SORTABLE,
    defaultSort: { key: 'name', order: 'asc' },
    filters: { statuses, roleIds, deleted },
    fetch: (query) =>
      fetchUsers(query, {
        statuses: statuses.value,
        roleIds: roleIds.value,
        includeDeleted: deleted.value.length > 0,
      }),
  })

  return { ...list, statuses, roleIds, deleted }
}
