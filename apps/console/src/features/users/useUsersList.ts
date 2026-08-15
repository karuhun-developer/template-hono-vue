import { ref, type Ref } from 'vue'

import { useResourceList, type UseResourceList } from '@/composables/useResourceList'
import { fetchUsers, USER_SORTABLE, type UserSortKey, type UserSummary } from '@/features/users/api'

/**
 * The users list, ready to hand to `UsersTable`.
 *
 * The two faceted filters are declared here rather than inside `useResourceList` because
 * they are specific to this endpoint: the composable only needs to know that they exist,
 * so that changing one resets the page and clears with Reset.
 */

export type UseUsersList = UseResourceList<UserSummary, UserSortKey> & {
  statuses: Ref<string[]>
  roleIds: Ref<string[]>
}

export function useUsersList(): UseUsersList {
  const statuses = ref<string[]>([])
  const roleIds = ref<string[]>([])

  const list = useResourceList<UserSummary, UserSortKey>({
    sortable: USER_SORTABLE,
    defaultSort: { key: 'name', order: 'asc' },
    filters: { statuses, roleIds },
    fetch: (query) => fetchUsers(query, { statuses: statuses.value, roleIds: roleIds.value }),
  })

  return { ...list, statuses, roleIds }
}
