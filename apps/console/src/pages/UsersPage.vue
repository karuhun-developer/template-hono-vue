<script setup lang="ts">
import { Button } from '@app/ui'
import { UserPlus } from '@lucide/vue'
import { computed, ref } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import { useRoleOptions } from '@/features/roles/useRoleOptions'
import {
  deleteUser,
  resendInvite,
  resetUserPassword,
  restoreUser,
  setUserStatus,
  type UserSaved,
  type UserSummary,
} from '@/features/users/api'
import InviteTokenDialog from '@/features/users/InviteTokenDialog.vue'
import UserFormDialog from '@/features/users/UserFormDialog.vue'
import UsersTable from '@/features/users/UsersTable.vue'
import { useUsersList } from '@/features/users/useUsersList'
import { useSessionStore } from '@/stores/session'

/**
 * Everyone who can sign in.
 *
 * The page is the wiring: it owns the list state, the dialogs and what happens when the
 * table asks for something. The table itself is `features/users/UsersTable.vue`, so any
 * other screen that needs this list can mount it without inheriting this page's buttons.
 *
 * An invitation or reset link appears exactly once, in a dialog, right after it is issued.
 * Neither can be read back from the list: what the database holds is only their hash.
 */

const session = useSessionStore()
const list = useUsersList()

/**
 * The role list is what the form and the Role filter need. Failing to load it does **not**
 * fail the page: somebody holding `user.read` without `role.read` may still look at the
 * list, they simply cannot change anyone's roles — and that button is already hidden.
 */
const { roles } = useRoleOptions()

const working = ref(false)

const formOpen = ref(false)
const editing = ref<UserSummary | null>(null)

const tokenOpen = ref(false)
const issued = ref<{
  kind: 'invite' | 'reset'
  email: string
  token: string | null
  expiresAt: string | null
} | null>(null)

/** Either key opens the dialog; which mode it lands in is `dialogMode()` inside it. */
const canAdd = computed(() => session.can('user.invite') || session.can('user.create'))

/* ------------------------------------------------------------------------------ actions */

function openAdd(): void {
  editing.value = null
  formOpen.value = true
}

function openEdit(user: UserSummary): void {
  editing.value = user
  formOpen.value = true
}

function onSaved(result: UserSaved): void {
  void list.reload()

  // Only the invite path carries one. Creating an account outright has no link to show,
  // and editing has nothing to issue.
  if (result.inviteToken) {
    showLink('invite', result.user.email, result.inviteToken, result.inviteExpiresAt)
  }
}

function showLink(
  kind: 'invite' | 'reset',
  email: string,
  token: string | null,
  expiresAt?: string | null,
): void {
  issued.value = { kind, email, token, expiresAt: expiresAt ?? null }
  tokenOpen.value = true
}

async function onResend(user: UserSummary): Promise<void> {
  list.failure.value = null

  const result = await resendInvite(user.id)
  if ('failure' in result) {
    list.failure.value = result.failure
    return
  }

  showLink('invite', user.email, result.data.inviteToken, result.data.inviteExpiresAt)
  await list.reload()
}

async function onResetPassword(user: UserSummary): Promise<void> {
  list.failure.value = null

  const result = await resetUserPassword(user.id)
  if ('failure' in result) {
    list.failure.value = result.failure
    return
  }

  showLink('reset', user.email, result.data.resetToken, result.data.resetExpiresAt)
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
 * Deleting is soft and reversible, and the confirmation says so rather than warning about
 * something that is not true. What it does warn about is the part that is not undone by
 * Restore: the address stays reserved, because releasing it would let a new account inherit
 * this one's audit trail.
 */
async function onRemove(user: UserSummary): Promise<void> {
  const confirmed = window.confirm(
    `Delete ${user.name}? They lose access immediately, and their email address stays reserved. You can restore the account afterwards.`,
  )
  if (!confirmed) return

  list.failure.value = null

  const result = await deleteUser(user.id)
  if ('failure' in result) {
    list.failure.value = result.failure
    return
  }

  await list.reload()
}

async function onRestore(user: UserSummary): Promise<void> {
  list.failure.value = null

  const result = await restoreUser(user.id)
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

      <Button v-if="canAdd" @click="openAdd">
        <UserPlus />
        <span class="hidden sm:inline">Add user</span>
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
      @reset-password="onResetPassword"
      @remove="onRemove"
      @restore="onRestore"
      @bulk-disable="onBulkDisable"
    />

    <UserFormDialog v-model:open="formOpen" :user="editing" :roles="roles" @saved="onSaved" />

    <InviteTokenDialog
      v-model:open="tokenOpen"
      :kind="issued?.kind ?? 'invite'"
      :email="issued?.email ?? ''"
      :token="issued?.token ?? null"
      :expires-at="issued?.expiresAt ?? null"
    />
  </div>
</template>
