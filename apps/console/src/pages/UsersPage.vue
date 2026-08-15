<script setup lang="ts">
import { Badge, Button, Card, CardContent, Input, Skeleton } from '@app/ui'
import { MailPlus, Pencil, Search, UserPlus } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import InviteTokenDialog from '@/components/InviteTokenDialog.vue'
import NativeSelect from '@/components/NativeSelect.vue'
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
 * The invitation link appears exactly once, in a dialog, right after it is issued. It can
 * never be read back from this list: what the database holds is only its hash.
 */

const session = useSessionStore()

const users = ref<UserSummary[]>([])
const roles = ref<RoleSummary[]>([])
const loading = ref(true)
const failure = ref<ApiFailure | null>(null)

const search = ref('')
const status = ref<'' | UserStatus>('')

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

onMounted(async () => {
  await Promise.all([load(), loadRoles()])
})

/**
 * Search is held for 300 ms. Without it, typing "anna" fires four requests whose answers
 * can arrive out of order — and what stays on screen is the result for "ann".
 */
let debounce: ReturnType<typeof setTimeout> | undefined
watch([search, status], () => {
  clearTimeout(debounce)
  debounce = setTimeout(() => void load(), 300)
})
onBeforeUnmount(() => clearTimeout(debounce))

async function load(): Promise<void> {
  loading.value = true
  failure.value = null

  try {
    const response = await api.users.$get({
      query: {
        ...(search.value.trim() === '' ? {} : { q: search.value.trim() }),
        ...(status.value === '' ? {} : { status: status.value }),
      },
    })

    if (!response.ok) {
      failure.value = await readApiError(response)
      return
    }

    users.value = (await response.json()).items
  } catch (error) {
    failure.value = networkFailure(error)
  } finally {
    loading.value = false
  }
}

/**
 * The role list is what the form needs. Failing to load it does **not** fail the page:
 * somebody holding `user.read` without `role.read` may still look at the list, they simply
 * cannot change anyone's roles — and that button is already hidden.
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
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Users</h1>
        <p class="text-muted-foreground text-sm">Everyone who can sign in, and what they hold.</p>
      </div>

      <Button v-if="canInvite" @click="openInvite">
        <UserPlus />
        <span class="hidden sm:inline">Invite</span>
      </Button>
    </div>

    <div class="flex gap-2">
      <div class="relative min-w-0 flex-1">
        <Search class="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4" />
        <Input v-model="search" placeholder="Search by name or email" class="pl-9" />
      </div>
      <NativeSelect v-model="status" aria-label="Filter by status" class="w-36 shrink-0">
        <option value="">All statuses</option>
        <option value="active">Active</option>
        <option value="invited">Invited</option>
        <option value="disabled">Disabled</option>
      </NativeSelect>
    </div>

    <FailureAlert :failure="failure" />

    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-24 w-full rounded-2xl" />
    </div>

    <Card v-else-if="users.length === 0">
      <CardContent class="text-muted-foreground py-10 text-center text-sm">
        No users match that.
      </CardContent>
    </Card>

    <Card v-for="user in users" v-else :key="user.id">
      <CardContent class="space-y-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="truncate font-medium">{{ user.name }}</p>
            <p class="text-muted-foreground truncate text-sm">{{ user.email }}</p>
          </div>
          <Badge :variant="STATUS_VARIANT[user.status]">{{ STATUS_LABEL[user.status] }}</Badge>
        </div>

        <div class="flex flex-wrap gap-1.5">
          <Badge v-for="role in user.roles" :key="role.roleId" variant="outline">
            {{ role.roleName }}
          </Badge>
          <span v-if="user.roles.length === 0" class="text-muted-foreground text-xs">No role</span>
        </div>

        <p class="text-muted-foreground text-xs">
          <template v-if="user.status === 'invited'">
            Invitation valid until {{ formatDateTime(user.inviteExpiresAt) }}
          </template>
          <template v-else-if="user.lastLoginAt">
            Last signed in {{ formatDateTime(user.lastLoginAt) }}
          </template>
          <template v-else>Never signed in</template>
        </p>

        <div class="flex flex-wrap gap-2">
          <Button v-if="canUpdate" variant="outline" size="sm" @click="openEdit(user)">
            <Pencil />
            Edit
          </Button>

          <Button
            v-if="canInvite && user.status === 'invited'"
            variant="outline"
            size="sm"
            @click="resend(user)"
          >
            <MailPlus />
            Re-send
          </Button>

          <!--
            Disabling your own account is refused by the API. The button is hidden rather
            than shown and then explained, because there is no version of that click that
            was going to work.
          -->
          <template v-if="canDisable && user.id !== session.user?.id">
            <Button
              v-if="user.status === 'active'"
              variant="ghost"
              size="sm"
              @click="setStatus(user, 'disabled')"
            >
              Disable
            </Button>
            <Button
              v-else-if="user.status === 'disabled'"
              variant="ghost"
              size="sm"
              @click="setStatus(user, 'active')"
            >
              Enable
            </Button>
          </template>
        </div>
      </CardContent>
    </Card>

    <UserFormDialog v-model:open="formOpen" :user="editing" :roles="roles" @saved="onSaved" />

    <InviteTokenDialog
      v-model:open="tokenOpen"
      :email="issued?.email ?? ''"
      :token="issued?.token ?? null"
      :expires-at="issued?.expiresAt ?? null"
    />
  </div>
</template>
