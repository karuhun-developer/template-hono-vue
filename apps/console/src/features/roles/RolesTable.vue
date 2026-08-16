<script setup lang="ts">
import {
  Badge,
  Button,
  DataTable,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  type DataTableColumn,
} from '@app/ui'
import { Ellipsis, Pencil, Trash2 } from '@lucide/vue'
import { computed } from 'vue'

import type { RoleSummary } from '@/features/roles/api'
import type { UseRolesList } from '@/features/roles/useRolesList'
import { useSessionStore } from '@/stores/session'

/**
 * The roles list, as a table.
 *
 * It renders and it emits; it decides nothing. The items below are hidden to keep people
 * from walking into a 403, not to prevent one — `requirePermission()` in the API is what
 * actually refuses.
 */

const props = defineProps<{ list: UseRolesList }>()

const emit = defineEmits<{
  edit: [role: RoleSummary]
  remove: [role: RoleSummary]
}>()

const session = useSessionStore()

// Destructured once: the composable hands back refs, and the object it returns never gets
// replaced. `<script setup>` unwraps them in the template; reading `props.list.page` there
// would not.
const { rows, total, loading, sort, page, perPage } = props.list

const canManage = computed(() => session.can('role.manage'))

/**
 * The columns.
 *
 * `key` is both the slot name and the value sent as `?sort=`, so a sortable key here has to
 * be one the API's enum accepts — `ROLE_SORTABLE` is that list, and `useResourceList` checks
 * against it.
 */
const COLUMNS: DataTableColumn[] = [
  { key: 'name', header: 'Role', sortable: true, hideable: false },
  { key: 'key', header: 'Key', sortable: true, class: 'w-56' },
  { key: 'permissions', header: 'Permissions', class: 'w-32' },
  { key: 'usedBy', header: 'Held by', sortable: true, class: 'w-28', align: 'end' },
]
</script>

<template>
  <DataTable
    v-model:sort="sort"
    v-model:page="page"
    v-model:per-page="perPage"
    :columns="COLUMNS"
    :rows="rows"
    :loading="loading"
    :total="total"
    row-key="id"
    storage-key="roles"
    empty="No roles yet."
  >
    <template #cell:name="{ row }">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span class="truncate font-medium">{{ row.name }}</span>
          <Badge v-if="row.isSystem" variant="secondary">Built-in</Badge>
        </div>
        <p v-if="row.description" class="text-muted-foreground truncate text-xs">
          {{ row.description }}
        </p>
      </div>
    </template>

    <template #cell:key="{ row }">
      <code class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{{ row.key }}</code>
    </template>

    <template #cell:permissions="{ row }">
      <span class="text-muted-foreground text-sm">{{ row.permissions.length }}</span>
    </template>

    <template #cell:usedBy="{ row }">
      <span class="text-muted-foreground text-sm">{{ row.usedBy }}</span>
    </template>

    <template v-if="canManage" #actions="{ row }">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" :aria-label="`Actions for ${row.name}`">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" class="w-44">
          <DropdownMenuItem @select="emit('edit', row)">
            <Pencil />
            Edit
          </DropdownMenuItem>

          <!--
            Delete is left out for a built-in role or one somebody still holds, rather
            than shown greyed out. A dead control that does not explain itself only
            invites people to click it again.
          -->
          <template v-if="!row.isSystem && row.usedBy === 0">
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" @select="emit('remove', row)">
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </template>
  </DataTable>
</template>
