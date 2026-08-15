<script setup lang="ts">
import { Button } from '@app/ui'
import { UserPlus } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import { resendInvite, setUserStatus, type UserSaved, type UserSummary } from '@/features/users/api'
import InviteTokenDialog from '@/features/users/InviteTokenDialog.vue'
import UserFormDialog from '@/features/users/UserFormDialog.vue'
import UsersTable from '@/features/users/UsersTable.vue'
import { useUsersList } from '@/features/users/useUsersList'
import { api } from '@/lib/api'
import type { RoleSummary } from '@/lib/models'
import { useSessionStore } from '@/stores/session'

/**
 * Everyone who can sign in.
 *
 * The page is the wiring: it owns the list state, the dialogs and what happens when the
 * table asks for something. The table itself is `features/users/UsersTable.vue`, so any
 * other screen that needs this list can mount it without inheriting this page's buttons.
 *
 * The invitation link appears exactly once, in a dialog, right after it is issued. It can
 * never be read back from the list: what the database holds is only its hash.
 */

const session = useSessionStore()
const list = useUsersList()

const roles = ref<RoleSummary[]>([])
const working = ref(false)

const formOpen = ref(false)
const editing = ref<UserSummary | null>(null)

const tokenOpen = ref(false)
const issued = ref<{ email: string; token: string; expiresAt: string | null } | null>(null)

const canInvite = computed(() => session.can('user.invite'))

onMounted(() => void loadRoles())

/**
 * The role list is what the form and the Role filter need. Failing to load it does **not**
 * fail the page: somebody holding `user.read` without `role.read` may still look at the
 * list, they simply cannot change anyone's roles — and that button is already hidden.
 */
async function loadRoles(): Promise<void> {
  try {
    // The form needs every role at once to draw its checkboxes, so it asks for the maximum
    // the API allows. Past a hundred roles this control has to become a picker with a
    // search box — see `docs/features/rbac.md`.
    const response = await api.roles.$get({ query: { perPage: '100' } })
    if (response.ok) roles.value = (await response.json()).items
  } catch {
    roles.value = []
  }
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

function onSaved(result: UserSaved): void {
  void list.reload()

  if (result.inviteToken) showToken(result.user.email, result.inviteToken, result.inviteExpiresAt)
}

function showToken(email: string, token: string, expiresAt?: string): void {
  issued.value = { email, token, expiresAt: expiresAt ?? null }
  tokenOpen.value = true
}

async function onResend(user: UserSummary): Promise<void> {
  list.failure.value = null

  const result = await resendInvite(user.id)
  if ('failure' in result) {
    list.failure.value = result.failure
    return
  }

  showToken(user.email, result.data.inviteToken, result.data.inviteExpiresAt)
  await list.reload()
}

async function onStatus(user: UserSummary, next: 'active' | 'disabled'): Promise<void> {
  list.failure.value = null

  const result = await setUserStatus(user.id, next)
  if ('failure' in result) {
    list.failure.value = result.failure
    return
  }

  await list.reload()
}

/**
 * One request per account, in order.
 *
 * The API has no bulk endpoint, and inventing one on the client — firing them all at once —
 * would leave a half-applied change nobody can read afterwards: which of the twelve failed?
 * Sequential stops at the first failure and reloads, so what is on screen is what actually
 * happened.
 */
async function onBulkDisable(users: UserSummary[]): Promise<void> {
  working.value = true
  list.failure.value = null

  try {
    for (const user of users) {
      const result = await setUserStatus(user.id, 'disabled')
      if ('failure' in result) {
        list.failure.value = result.failure
        break
      }
    }
  } finally {
    working.value = false
    await list.reload()
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

    <FailureAlert :failure="list.failure.value" />

    <UsersTable
      :list="list"
      :roles="roles"
      :busy="working"
      @edit="openEdit"
      @resend="onResend"
      @status="onStatus"
      @bulk-disable="onBulkDisable"
    />

    <UserFormDialog v-model:open="formOpen" :user="editing" :roles="roles" @saved="onSaved" />

    <InviteTokenDialog
      v-model:open="tokenOpen"
      :email="issued?.email ?? ''"
      :token="issued?.token ?? null"
      :expires-at="issued?.expiresAt ?? null"
    />
  </div>
</template>
