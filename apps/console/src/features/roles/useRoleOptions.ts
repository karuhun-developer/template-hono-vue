import { onMounted, ref, type Ref } from 'vue'

import { fetchRoleOptions, type RoleSummary } from '@/features/roles/api'

/**
 * Every role at once, for a screen that needs to draw checkboxes rather than a page.
 *
 * It belongs to the roles module even though its only caller today is the user list — which
 * is exactly the case the `features/` split is for. A page needing the user edit dialog gets
 * the role list it feeds on with it, instead of copying the `perPage=100` call and, sooner
 * or later, forgetting the part that makes a failure non-fatal.
 */

export type UseRoleOptions = {
  roles: Ref<RoleSummary[]>
  reload: () => Promise<void>
}

export function useRoleOptions(): UseRoleOptions {
  const roles = ref<RoleSummary[]>([])

  async function reload(): Promise<void> {
    roles.value = await fetchRoleOptions()
  }

  onMounted(() => void reload())

  return { roles, reload }
}
