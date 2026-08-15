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
  type DataTableSort,
} from '@app/ui'
import { Ellipsis, MailPlus, Pencil, Search, UserPlus, X } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import InviteTokenDialog from '@/components/InviteTokenDialog.vue'
import UserFormDialog from '@/components/UserFormDialog.vue'
import { api } from '@/lib/api'
import { networkFailure, readApiError, type ApiFailure } from '@/lib/api-error'
import { formatDateTime } from '@/lib/format'
import type { RoleSummary, UserStatus, UserSummary } from '@/lib/models'
import { useSessionStore } from '@/stores/session'

/**
 * Everyone who can sign in.
 *
 * Each action sits behind its own permission — inviting, editing, enabling and disabling —
 * and every one of them is enforced again in the API. The buttons below are hidden to keep
 * people from walking into a 403, not to prevent one.
 *
 * Searching, filtering, sorting and paging all happen in the API. Nothing on this page
 * looks at more rows than are on the screen, which is what keeps it the same page at three
 * users and at thirty thousand.
 *
 * The invitation link appears exactly once, in a dialog, right after it is issued. It can
 * never be read back from this list: what the database holds is only its hash.
 */

const session = useSessionStore()

const users = ref<UserSummary[]>([])
const roles = ref<RoleSummary[]>([])
const total = ref(0)
const loading = ref(true)
const failure = ref<ApiFailure | null>(null)

/* -------------------------------------------------------------- what is being asked for */

/** What is typed, and what has been asked for — see the debounce below. */
const search = ref('')
const q = ref('')

const statuses = ref<string[]>([])
const roleIds = ref<string[]>([])

const sort = ref<DataTableSort>({ key: 'name', order: 'asc' })
const page = ref(1)
const perPage = ref(10)

const selected = ref<string[]>([])
const working = ref(false)

const formOpen = ref(false)
const editing = ref<UserSummary | null>(null)

const tokenOpen = ref(false)
const issued = ref<{ email: string; token: string; expiresAt: string | null } | null>(null)

const canInvite = computed(() => session.can('user.invite'))
const canUpdate = computed(() => session.can('user.update'))
const canDisable = computed(() => session.can('user.disable'))

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

const roleFacets = computed(() => roles.value.map((role) => ({ value: role.id, label: role.name })))

/**
 * The columns.
 *
 * `key` is both the slot name and the value sent as `?sort=`, so a sortable key here has
 * to be one the API's enum accepts — `SORTABLE` below is the list, and it is the same
 * list `listUsersQuery` validates against.
 */
const COLUMNS: DataTableColumn[] = [
  { key: 'name', header: 'Name', sortable: true, hideable: false },
  { key: 'roles', header: 'Roles' },
  { key: 'status', header: 'Status', sortable: true, class: 'w-32' },
  { key: 'lastLoginAt', header: 'Last seen', sortable: true, class: 'w-52' },
  { key: 'createdAt', header: 'Added', sortable: true, class: 'w-44', hidden: true },
]

const SORTABLE = ['name', 'email', 'status', 'lastLoginAt', 'createdAt'] as const
type SortKey = (typeof SORTABLE)[number]

/** A sort the API would refuse falls back to the default rather than 400ing the page. */
const sortKey = computed<SortKey>(() => {
  const key = sort.value?.key
  return SORTABLE.includes(key as SortKey) ? (key as SortKey) : 'name'
})

const filtered = computed(
  () => q.value !== '' || statuses.value.length > 0 || roleIds.value.length > 0,
)

/* ------------------------------------------------------------------------------ loading */

onMounted(async () => {
  await Promise.all([load(), loadRoles()])
})

/**
 * Search is held for 300 ms. Without it, typing "anna" fires four requests whose answers
 * can arrive out of order — and what stays on screen is the result for "ann".
 */
let debounce: ReturnType<typeof setTimeout> | undefined
watch(search, (value) => {
  clearTimeout(debounce)
  debounce = setTimeout(() => (q.value = value.trim()), 300)
})
onBeforeUnmount(() => clearTimeout(debounce))

/**
 * Narrowing the list puts you back on page one. Page 7 of the old list is almost never a
 * page of the new one, and landing on an empty page reads as "no results" when there are
 * plenty on page 1.
 */
watch([q, statuses, roleIds], () => {
  page.value = 1
})

/**
 * One request per change of the question, whatever changed it. Vue coalesces the writes in
 * a tick, so narrowing the filter *and* resetting the page above is still a single load —
 * which is exactly what a watcher per control would not give you.
 */
watch([q, statuses, roleIds, sort, page, perPage], () => void load())

async function load(): Promise<void> {
  loading.value = true
  failure.value = null

  try {
    const response = await api.users.$get({
      query: {
        ...(q.value === '' ? {} : { q: q.value }),
        // Sent once per ticked box; the API reads a repeated parameter as a set.
        ...(statuses.value.length === 0 ? {} : { status: statuses.value as UserStatus[] }),
        ...(roleIds.value.length === 0 ? {} : { roleId: roleIds.value }),
        page: String(page.value),
        perPage: String(perPage.value),
        sort: sortKey.value,
        order: sort.value?.order ?? 'asc',
      },
    })

    if (!response.ok) {
      failure.value = await readApiError(response)
      return
    }

    const body = await response.json()
    users.value = body.items
    total.value = body.total
  } catch (error) {
    failure.value = networkFailure(error)
  } finally {
    loading.value = false
  }
}

/**
 * The role list is what the form and the Role filter need. Failing to load it does **not**
 * fail the page: somebody holding `user.read` without `role.read` may still look at the
 * list, they simply cannot change anyone's roles — and that button is already hidden.
 */
async function loadRoles(): Promise<void> {
  try {
    // The form needs every role at once to draw its checkboxes, so it asks for the
    // maximum the API allows. Past a hundred roles this control has to become a picker
    // with a search box — see `docs/features/rbac.md`.
    const response = await api.roles.$get({ query: { perPage: '100' } })
    if (response.ok) roles.value = (await response.json()).items
  } catch {
    roles.value = []
  }
}

function reset(): void {
  search.value = ''
  q.value = ''
  statuses.value = []
  roleIds.value = []
}

/* ------------------------------------------------------------------------------ actions */

function openInvite(): void {
  editing.value = null
  formOpen.value = true
}

function openEdit(user: UserSummary): void {
  editing.value = user
  formOpen.value = true
}

function onSaved(result: {
  user: UserSummary
  inviteToken?: string
  inviteExpiresAt?: string
}): void {
  void load()

  if (result.inviteToken) showToken(result.user.email, result.inviteToken, result.inviteExpiresAt)
}

function showToken(email: string, token: string, expiresAt?: string): void {
  issued.value = { email, token, expiresAt: expiresAt ?? null }
  tokenOpen.value = true
}

async function resend(user: UserSummary): Promise<void> {
  failure.value = null

  try {
    const response = await api.users[':id'].invite.$post({ param: { id: user.id } })
    if (!response.ok) {
      failure.value = await readApiError(response)
      return
    }

    const body = await response.json()
    showToken(user.email, body.inviteToken, body.inviteExpiresAt)
    await load()
  } catch (error) {
    failure.value = networkFailure(error)
  }
}

async function setStatus(user: UserSummary, next: 'active' | 'disabled'): Promise<void> {
  failure.value = null

  try {
    const response = await api.users[':id'].status.$post({
      param: { id: user.id },
      json: { status: next },
    })

    if (!response.ok) {
      failure.value = await readApiError(response)
      return
    }

    await load()
  } catch (error) {
    failure.value = networkFailure(error)
  }
}

/**
 * Disabling your own account is refused by the API, and an account that is already
 * disabled has nothing to do — both are dropped here so the bulk button is greyed out
 * rather than reporting a failure the person could not have avoided.
 */
const disablable = computed(() =>
  users.value.filter(
    (user) =>
      selected.value.includes(user.id) &&
      user.status !== 'disabled' &&
      user.id !== session.user?.id,
  ),
)

/**
 * One request per account, in order.
 *
 * The API has no bulk endpoint, and inventing one on the client — firing them all at once
 * — would leave a half-applied change nobody can read afterwards: which of the twelve
 * failed? Sequential stops at the first failure and reloads, so what is on screen is what
 * actually happened.
 */
async function disableSelected(): Promise<void> {
  working.value = true
  failure.value = null

  try {
    for (const user of disablable.value) {
      const response = await api.users[':id'].status.$post({
        param: { id: user.id },
        json: { status: 'disabled' },
      })

      if (!response.ok) {
        failure.value = await readApiError(response)
        break
      }
    }
  } catch (error) {
    failure.value = networkFailure(error)
  } finally {
    working.value = false
    selected.value = []
    await load()
  }
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h2 class="text-2xl font-semibold tracking-tight">Users</h2>
        <p class="text-muted-foreground text-sm">Everyone who can sign in, and what they hold.</p>
      </div>

      <Button v-if="canInvite" @click="openInvite">
        <UserPlus />
        <span class="hidden sm:inline">Invite</span>
      </Button>
    </div>

    <FailureAlert :failure="failure" />

    <DataTable
      v-model:sort="sort"
      v-model:page="page"
      v-model:per-page="perPage"
      v-model:selected="selected"
      :columns="COLUMNS"
      :rows="users"
      :loading="loading"
      :total="total"
      row-key="id"
      storage-key="users"
      selectable
      empty="No users match that."
    >
      <template #toolbar>
        <div class="relative w-full sm:w-64">
          <Search
            class="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4"
          />
          <Input v-model="search" placeholder="Search by name or email" class="pl-9" />
        </div>

        <DataTableFacetedFilter v-model="statuses" label="Status" :options="STATUS_FACETS" />
        <DataTableFacetedFilter
          v-if="roleFacets.length > 0"
          v-model="roleIds"
          label="Role"
          :options="roleFacets"
        />

        <Button v-if="filtered" variant="ghost" size="sm" @click="reset">
          Reset
          <X />
        </Button>
      </template>

      <template #cell:name="{ row }">
        <div class="flex items-center gap-3">
          <Avatar class="size-8">
            <AvatarFallback>{{ initialsOf(row.name) }}</AvatarFallback>
          </Avatar>
          <div class="min-w-0">
            <p class="truncate font-medium">{{ row.name }}</p>
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
        <Badge :variant="STATUS_VARIANT[row.status]">{{ STATUS_LABEL[row.status] }}</Badge>
      </template>

      <template #cell:lastLoginAt="{ row }">
        <span class="text-muted-foreground text-sm">
          <template v-if="row.status === 'invited'">
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

          <DropdownMenuContent align="end" class="w-44">
            <DropdownMenuItem v-if="canUpdate" @select="openEdit(row)">
              <Pencil />
              Edit
            </DropdownMenuItem>

            <DropdownMenuItem v-if="canInvite && row.status === 'invited'" @select="resend(row)">
              <MailPlus />
              Re-send invitation
            </DropdownMenuItem>

            <!--
              Disabling your own account is refused by the API. The item is left out rather
              than shown and then explained, because there is no version of that click that
              was going to work.
            -->
            <template v-if="canDisable && row.id !== session.user?.id">
              <DropdownMenuSeparator v-if="canUpdate" />
              <DropdownMenuItem v-if="row.status === 'disabled'" @select="setStatus(row, 'active')">
                Enable
              </DropdownMenuItem>
              <DropdownMenuItem v-else variant="destructive" @select="setStatus(row, 'disabled')">
                Disable
              </DropdownMenuItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </template>

      <template v-if="canDisable" #bulk>
        <Button
          variant="outline"
          size="sm"
          class="rounded-full"
          :disabled="working || disablable.length === 0"
          @click="disableSelected"
        >
          {{ working ? 'Disabling…' : `Disable ${disablable.length}` }}
        </Button>
      </template>
    </DataTable>

    <UserFormDialog v-model:open="formOpen" :user="editing" :roles="roles" @saved="onSaved" />

    <InviteTokenDialog
      v-model:open="tokenOpen"
      :email="issued?.email ?? ''"
      :token="issued?.token ?? null"
      :expires-at="issued?.expiresAt ?? null"
    />
  </div>
</template>
