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
  type DataTableSort,
} from '@app/ui'
import { Ellipsis, Pencil, Plus, Trash2 } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import RoleFormDialog from '@/components/RoleFormDialog.vue'
import { api } from '@/lib/api'
import { networkFailure, readApiError, type ApiFailure } from '@/lib/api-error'
import type { PermissionCatalog, RoleSummary } from '@/lib/models'
import { useSessionStore } from '@/stores/session'

/**
 * The roles this application has.
 *
 * Built-in roles (`isSystem`) can be edited but not deleted, and neither can a role someone
 * still holds. Both refusals are deliberate: deleting a role takes access away from
 * everybody holding it, and that should never happen as a side effect of tidying up a list.
 *
 * The permission catalog is loaded once with the first page and kept, because it does not
 * change between pages — it is the application's own list of what can be granted.
 */

const session = useSessionStore()

const roles = ref<RoleSummary[]>([])
const catalog = ref<PermissionCatalog>({ groups: [], granted: [] })
const total = ref(0)
const loading = ref(true)
const failure = ref<ApiFailure | null>(null)

const sort = ref<DataTableSort>({ key: 'name', order: 'asc' })
const page = ref(1)
const perPage = ref(10)

const formOpen = ref(false)
const editing = ref<RoleSummary | null>(null)

const canManage = computed(() => session.can('role.manage'))

const COLUMNS: DataTableColumn[] = [
  { key: 'name', header: 'Role', sortable: true, hideable: false },
  { key: 'key', header: 'Key', sortable: true, class: 'w-56' },
  { key: 'permissions', header: 'Permissions', class: 'w-32' },
  { key: 'usedBy', header: 'Held by', sortable: true, class: 'w-28', align: 'end' },
]

const SORTABLE = ['name', 'key', 'usedBy'] as const
type SortKey = (typeof SORTABLE)[number]

/** A sort the API would refuse falls back to the default rather than 400ing the page. */
const sortKey = computed<SortKey>(() => {
  const key = sort.value?.key
  return SORTABLE.includes(key as SortKey) ? (key as SortKey) : 'name'
})

onMounted(async () => {
  await load()
})

watch([sort, page, perPage], () => void load())

async function load(): Promise<void> {
  loading.value = true
  failure.value = null

  try {
    const [list, permissions] = await Promise.all([
      api.roles.$get({
        query: {
          page: String(page.value),
          perPage: String(perPage.value),
          sort: sortKey.value,
          order: sort.value?.order ?? 'asc',
        },
      }),
      // Asked for once. `catalog.groups` is fixed at build time, so re-fetching it on every
      // page turn would be a request whose answer is already on screen.
      catalog.value.groups.length === 0 ? api.roles.permissions.$get() : null,
    ])

    if (!list.ok) {
      failure.value = await readApiError(list)
      return
    }
    if (permissions && !permissions.ok) {
      failure.value = await readApiError(permissions)
      return
    }

    const body = await list.json()
    roles.value = body.items
    total.value = body.total

    if (permissions) catalog.value = await permissions.json()
  } catch (error) {
    failure.value = networkFailure(error)
  } finally {
    loading.value = false
  }
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

  failure.value = null

  try {
    const response = await api.roles[':id'].$delete({ param: { id: role.id } })
    if (!response.ok) {
      failure.value = await readApiError(response)
      return
    }

    await load()
  } catch (error) {
    failure.value = networkFailure(error)
  }
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

    <FailureAlert :failure="failure" />

    <DataTable
      v-model:sort="sort"
      v-model:page="page"
      v-model:per-page="perPage"
      :columns="COLUMNS"
      :rows="roles"
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
            <DropdownMenuItem @select="openEdit(row)">
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
              <DropdownMenuItem variant="destructive" @select="remove(row)">
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </template>
    </DataTable>

    <RoleFormDialog v-model:open="formOpen" :role="editing" :catalog="catalog" @saved="load" />
  </div>
</template>
