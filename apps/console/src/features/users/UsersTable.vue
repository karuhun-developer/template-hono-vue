<script setup lang="ts">
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  DataTable,
  DataTableFacetedFilter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  initialsOf,
  Input,
  type DataTableColumn,
} from '@app/ui'
import { Ellipsis, KeyRound, MailPlus, Pencil, RotateCcw, Search, Trash2, X } from '@lucide/vue'
import { computed, ref } from 'vue'

import type { UserStatus, UserSummary } from '@/features/users/api'
import type { UseUsersList } from '@/features/users/useUsersList'
import { formatDateTime } from '@/lib/format'
import type { RoleSummary } from '@/lib/models'
import { useSessionStore } from '@/stores/session'

/**
 * The users list, as a table.
 *
 * It renders and it emits; it decides nothing. Every action leaves through an event, so a
 * page that wants this list with a different set of buttons around it can have one — and
 * so the enforcement stays where it belongs. The items below are hidden to keep people from
 * walking into a 403, not to prevent one: `requirePermission()` in the API is what actually
 * refuses.
 *
 * Searching, filtering, sorting and paging all happen in the API. Nothing here looks at
 * more rows than are on the screen, which is what keeps it the same table at three users
 * and at thirty thousand.
 */

const props = defineProps<{
  list: UseUsersList
  /** For the Role facet. An empty list simply hides it — see `loadRoles` in the page. */
  roles: readonly RoleSummary[]
  /** True while the page is applying a bulk action, so the button can say so. */
  busy?: boolean
}>()

const emit = defineEmits<{
  edit: [user: UserSummary]
  resend: [user: UserSummary]
  status: [user: UserSummary, next: 'active' | 'disabled']
  resetPassword: [user: UserSummary]
  remove: [user: UserSummary]
  restore: [user: UserSummary]
  bulkDisable: [users: UserSummary[]]
}>()

const session = useSessionStore()

// Destructured once: the composable hands back refs, and the object it returns never gets
// replaced. `<script setup>` unwraps them in the template; reading `props.list.page` there
// would not.
const {
  rows,
  total,
  loading,
  search,
  sort,
  page,
  perPage,
  filtered,
  statuses,
  roleIds,
  deleted,
  reset,
} = props.list

const selected = ref<string[]>([])

const canInvite = computed(() => session.can('user.invite'))
const canUpdate = computed(() => session.can('user.update'))
const canDisable = computed(() => session.can('user.disable'))
const canDelete = computed(() => session.can('user.delete'))
const canResetPassword = computed(() => session.can('user.reset_password'))

const STATUS_LABEL: Record<UserStatus, string> = {
  invited: 'Invited',
  active: 'Active',
  disabled: 'Disabled',
}

const STATUS_VARIANT: Record<UserStatus, 'secondary' | 'success' | 'warning'> = {
  invited: 'warning',
  active: 'success',
  disabled: 'secondary',
}

const STATUS_FACETS = (Object.keys(STATUS_LABEL) as UserStatus[]).map((value) => ({
  value,
  label: STATUS_LABEL[value],
}))

const roleFacets = computed(() => props.roles.map((role) => ({ value: role.id, label: role.name })))

/**
 * One option, because it is one switch. A facet rather than a checkbox so that ticking it
 * resets the page and clears with Reset like every other way of narrowing this list — see
 * the note on `deleted` in `useUsersList`.
 */
const DELETED_FACETS = [{ value: 'include', label: 'Include deleted accounts' }]

/**
 * The columns.
 *
 * `key` is both the slot name and the value sent as `?sort=`, so a sortable key here has to
 * be one the API's enum accepts — `USER_SORTABLE` is that list, and `useResourceList`
 * checks against it.
 */
const COLUMNS: DataTableColumn[] = [
  { key: 'name', header: 'Name', sortable: true, hideable: false },
  { key: 'roles', header: 'Roles' },
  { key: 'status', header: 'Status', sortable: true, class: 'w-32' },
  { key: 'lastLoginAt', header: 'Last seen', sortable: true, class: 'w-52' },
  { key: 'createdAt', header: 'Added', sortable: true, class: 'w-44', hidden: true },
]

/**
 * Disabling your own account is refused by the API, and an account that is already disabled
 * has nothing to do — both are dropped here so the bulk button is greyed out rather than
 * reporting a failure the person could not have avoided.
 */
const disablable = computed(() =>
  rows.value.filter(
    (user) =>
      selected.value.includes(user.id) &&
      user.status !== 'disabled' &&
      user.deletedAt === null &&
      user.id !== session.user?.id,
  ),
)

function onBulkDisable(): void {
  emit('bulkDisable', disablable.value)
  selected.value = []
}
</script>

<template>
  <DataTable
    v-model:sort="sort"
    v-model:page="page"
    v-model:per-page="perPage"
    v-model:selected="selected"
    :columns="COLUMNS"
    :rows="rows"
    :loading="loading"
    :total="total"
    row-key="id"
    storage-key="users"
    selectable
    empty="No users match that."
  >
    <template #toolbar>
      <div class="relative w-full sm:w-64">
        <Search class="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4" />
        <Input v-model="search" placeholder="Search by name or email" class="pl-9" />
      </div>

      <DataTableFacetedFilter v-model="statuses" label="Status" :options="STATUS_FACETS" />
      <DataTableFacetedFilter
        v-if="roleFacets.length > 0"
        v-model="roleIds"
        label="Role"
        :options="roleFacets"
      />

      <DataTableFacetedFilter
        v-if="canDelete"
        v-model="deleted"
        label="Deleted"
        :options="DELETED_FACETS"
      />

      <Button v-if="filtered" variant="ghost" size="sm" @click="reset">
        Reset
        <X />
      </Button>
    </template>

    <!--
      A deleted row is struck through rather than dropped: it is only visible at all because
      somebody ticked "Include deleted accounts", and the answer to "why can I not invite
      this address" is easier to see than to explain.
    -->
    <template #cell:name="{ row }">
      <div class="flex items-center gap-3" :class="{ 'opacity-60': row.deletedAt }">
        <Avatar class="size-8">
          <AvatarFallback>{{ initialsOf(row.name) }}</AvatarFallback>
        </Avatar>
        <div class="min-w-0">
          <p class="truncate font-medium" :class="{ 'line-through': row.deletedAt }">
            {{ row.name }}
          </p>
          <p class="text-muted-foreground truncate text-xs">{{ row.email }}</p>
        </div>
      </div>
    </template>

    <template #cell:roles="{ row }">
      <div class="flex flex-wrap gap-1">
        <Badge v-for="role in row.roles" :key="role.roleId" variant="outline">
          {{ role.roleName }}
        </Badge>
        <span v-if="row.roles.length === 0" class="text-muted-foreground text-xs">No role</span>
      </div>
    </template>

    <template #cell:status="{ row }">
      <Badge v-if="row.deletedAt" variant="secondary">Deleted</Badge>
      <Badge v-else :variant="STATUS_VARIANT[row.status]">{{ STATUS_LABEL[row.status] }}</Badge>
    </template>

    <template #cell:lastLoginAt="{ row }">
      <span class="text-muted-foreground text-sm">
        <template v-if="row.deletedAt">Deleted {{ formatDateTime(row.deletedAt) }}</template>
        <template v-else-if="row.status === 'invited'">
          Invited until {{ formatDateTime(row.inviteExpiresAt) }}
        </template>
        <template v-else-if="row.lastLoginAt">{{ formatDateTime(row.lastLoginAt) }}</template>
        <template v-else>Never signed in</template>
      </span>
    </template>

    <template #cell:createdAt="{ row }">
      <span class="text-muted-foreground text-sm">{{ formatDateTime(row.createdAt) }}</span>
    </template>

    <template #actions="{ row }">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" :aria-label="`Actions for ${row.name}`">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" class="w-52">
          <!--
            A deleted account is offered one thing: put it back. Editing the name of
            somebody who has been removed, or starting a password reset they can never
            complete, are both clicks with nothing behind them.
          -->
          <DropdownMenuItem v-if="row.deletedAt" @select="emit('restore', row)">
            <RotateCcw />
            Restore
          </DropdownMenuItem>

          <template v-else>
            <DropdownMenuItem v-if="canUpdate" @select="emit('edit', row)">
              <Pencil />
              Edit
            </DropdownMenuItem>

            <DropdownMenuItem
              v-if="canInvite && row.status === 'invited'"
              @select="emit('resend', row)"
            >
              <MailPlus />
              Re-send invitation
            </DropdownMenuItem>

            <!--
              Only for an account that has a password to reset. An invited one has never
              had one and a disabled one must not sign in at all — the API refuses both by
              name, and this keeps people from finding that out by clicking.
            -->
            <DropdownMenuItem
              v-if="canResetPassword && row.status === 'active'"
              @select="emit('resetPassword', row)"
            >
              <KeyRound />
              Reset password
            </DropdownMenuItem>

            <!--
              Disabling or deleting your own account is refused by the API. The items are
              left out rather than shown and then explained, because there is no version of
              those clicks that was going to work.
            -->
            <template v-if="row.id !== session.user?.id">
              <DropdownMenuSeparator v-if="canUpdate && (canDisable || canDelete)" />

              <template v-if="canDisable">
                <DropdownMenuItem
                  v-if="row.status === 'disabled'"
                  @select="emit('status', row, 'active')"
                >
                  Enable
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-else
                  variant="destructive"
                  @select="emit('status', row, 'disabled')"
                >
                  Disable
                </DropdownMenuItem>
              </template>

              <DropdownMenuItem
                v-if="canDelete"
                variant="destructive"
                @select="emit('remove', row)"
              >
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </template>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </template>

    <template v-if="canDisable" #bulk>
      <Button
        variant="outline"
        size="sm"
        class="rounded-full"
        :disabled="busy || disablable.length === 0"
        @click="onBulkDisable"
      >
        {{ busy ? 'Disabling…' : `Disable ${disablable.length}` }}
      </Button>
    </template>
  </DataTable>
</template>
