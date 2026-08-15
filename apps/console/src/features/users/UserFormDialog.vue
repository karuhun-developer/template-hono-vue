<script setup lang="ts">
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@app/ui'
import { LoaderCircle } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import RolesEditor from '@/components/RolesEditor.vue'
import { inviteUser, updateUser, type UserSaved, type UserSummary } from '@/features/users/api'
import type { ApiFailure } from '@/lib/api-error'
import type { RoleSummary } from '@/lib/models'

/**
 * Invite and edit, in one dialog.
 *
 * One component for two actions because the contents are identical except for a single
 * field: the email address exists only while inviting. It **cannot be changed afterwards**
 * — it is both the login identity and the target of the unique index on `lower(email)`, so
 * changing it means handing the account to a different person, and that should be a new
 * invitation rather than an edit.
 *
 * It lives in `features/users/` rather than `components/` because it belongs to one module:
 * any screen that needs to invite or edit somebody imports it from here, and gets the calls
 * and the types along with it.
 */

const props = defineProps<{
  open: boolean
  user: UserSummary | null
  roles: readonly RoleSummary[]
}>()

const emit = defineEmits<{
  'update:open': [boolean]
  saved: [UserSaved]
}>()

const mode = computed<'invite' | 'edit'>(() => (props.user === null ? 'invite' : 'edit'))

const email = ref('')
const name = ref('')
const roleIds = ref<string[]>([])
const submitting = ref(false)
const failure = ref<ApiFailure | null>(null)

// Reset on open rather than on close: a dialog that clears itself while fading out shows
// the fields emptying, and reopening is the only moment the values are actually needed.
watch(
  () => props.open,
  (open) => {
    if (!open) return

    failure.value = null
    submitting.value = false

    const user = props.user
    email.value = user?.email ?? ''
    name.value = user?.name ?? ''
    roleIds.value = user?.roles.map((role) => role.roleId) ?? []
  },
  { immediate: true },
)

async function submit(): Promise<void> {
  if (submitting.value) return

  if (roleIds.value.length === 0) {
    failure.value = {
      code: 'validation_failed',
      message: 'Pick at least one role — an account without one cannot open anything.',
      status: 0,
    }
    return
  }

  submitting.value = true
  failure.value = null

  const user = props.user
  const result =
    user === null
      ? await inviteUser({
          email: email.value.trim(),
          name: name.value.trim(),
          roleIds: roleIds.value,
        })
      : await updateUser(user.id, { name: name.value.trim(), roleIds: roleIds.value })

  submitting.value = false

  if ('failure' in result) {
    failure.value = result.failure
    return
  }

  emit('saved', result.data)
  emit('update:open', false)
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ mode === 'invite' ? 'Invite someone' : 'Edit user' }}</DialogTitle>
        <DialogDescription>
          <template v-if="mode === 'invite'">
            They will get a single-use link to choose their own password.
          </template>
          <template v-else>{{ user?.email }}</template>
        </DialogDescription>
      </DialogHeader>

      <form class="space-y-4" novalidate @submit.prevent="submit">
        <div v-if="mode === 'invite'" class="space-y-2">
          <Label for="user-email">Email</Label>
          <Input
            id="user-email"
            v-model="email"
            type="email"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            placeholder="someone@example.com"
            required
          />
        </div>

        <div class="space-y-2">
          <Label for="user-name">Name</Label>
          <Input id="user-name" v-model="name" autocomplete="off" required />
        </div>

        <RolesEditor v-model="roleIds" :roles="roles" :disabled="submitting" />

        <FailureAlert :failure="failure" />

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            :disabled="submitting"
            @click="emit('update:open', false)"
          >
            Cancel
          </Button>
          <Button type="submit" :disabled="submitting">
            <LoaderCircle v-if="submitting" class="animate-spin" />
            {{ mode === 'invite' ? 'Send invitation' : 'Save' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
