<script setup lang="ts">
import { Button } from '@app/ui'
import { Plus } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import { deleteRole, fetchPermissionCatalog, type PermissionCatalog } from '@/features/roles/api'
import RoleFormDialog from '@/features/roles/RoleFormDialog.vue'
import RolesTable from '@/features/roles/RolesTable.vue'
import { useRolesList } from '@/features/roles/useRolesList'
import type { RoleSummary } from '@/lib/models'
import { useSessionStore } from '@/stores/session'

/**
 * The roles this application has.
 *
 * Built-in roles (`isSystem`) can be edited but not deleted, and neither can a role someone
 * still holds. Both refusals are deliberate: deleting a role takes access away from
 * everybody holding it, and that should never happen as a side effect of tidying up a list.
 *
 * The page is the wiring: the list state is `useRolesList`, the table is
 * `features/roles/RolesTable.vue`, and what happens on a click is here.
 */

const session = useSessionStore()
const list = useRolesList()

/**
 * Loaded once with the first page and kept, because it does not change between pages — it is
 * the application's own list of what can be granted, fixed at build time.
 */
const catalog = ref<PermissionCatalog>({ groups: [], granted: [] })

const formOpen = ref(false)
const editing = ref<RoleSummary | null>(null)

const canManage = computed(() => session.can('role.manage'))

onMounted(() => void loadCatalog())

async function loadCatalog(): Promise<void> {
  const result = await fetchPermissionCatalog()
  if ('failure' in result) {
    list.failure.value = result.failure
    return
  }

  catalog.value = result
}

function openCreate(): void {
  editing.value = null
  formOpen.value = true
}

function openEdit(role: RoleSummary): void {
  editing.value = role
  formOpen.value = true
}

async function remove(role: RoleSummary): Promise<void> {
  if (!window.confirm(`Delete the role "${role.name}"? This cannot be undone.`)) return

  list.failure.value = null

  const result = await deleteRole(role.id)
  if ('failure' in result) {
    list.failure.value = result.failure
    return
  }

  await list.reload()
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h2 class="text-2xl font-semibold tracking-tight">Roles</h2>
        <p class="text-muted-foreground text-sm">
          Sets of permissions. What somebody can do is the union of the roles they hold.
        </p>
      </div>

      <Button v-if="canManage" @click="openCreate">
        <Plus />
        <span class="hidden sm:inline">New role</span>
      </Button>
    </div>

    <FailureAlert :failure="list.failure.value" />

    <RolesTable :list="list" @edit="openEdit" @remove="remove" />

    <RoleFormDialog
      v-model:open="formOpen"
      :role="editing"
      :catalog="catalog"
      @saved="list.reload"
    />
  </div>
</template>
