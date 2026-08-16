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
import { LoaderCircle, RefreshCw } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import RolesEditor from '@/components/RolesEditor.vue'
import {
  createUser,
  dialogMode,
  inviteUser,
  offeredModes,
  updateUser,
  type UserDialogMode,
  type UserSaved,
  type UserSummary,
} from '@/features/users/api'
import type { ActionResult, ApiFailure } from '@/lib/api-error'
import type { RoleSummary } from '@/lib/models'
import { useSessionStore } from '@/stores/session'

/**
 * Invite, create and edit, in one dialog.
 *
 * One component for three actions because the contents differ by a field each: the email
 * address exists only while the account is being made, and the password only while it is
 * being made *with one*. The address **cannot be changed afterwards** — it is both the login
 * identity and the target of the unique index on `lower(email)`, so changing it means
 * handing the account to a different person, and that should be a new invitation rather
 * than an edit.
 *
 * Which mode it opens in is `dialogMode()` in `api.ts`, so the branch that decides which
 * endpoint a submit reaches is a pure function with a test rather than a ternary in a
 * template. Whoever holds both keys gets the switch below; whoever holds one never sees it.
 * None of that refuses anything — `requirePermission()` on each route does.
 *
 * It lives in `features/users/` rather than `components/` because it belongs to one module:
 * any screen that needs to invite, create or edit somebody imports it from here, and gets
 * the calls and the types along with it.
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

const session = useSessionStore()

const modes = computed(() => offeredModes(props.user, session.can))
const mode = ref<UserDialogMode>('invite')

const email = ref('')
const name = ref('')
const password = ref('')
const roleIds = ref<string[]>([])
const submitting = ref(false)
const failure = ref<ApiFailure | null>(null)

const COPY: Record<UserDialogMode, { title: string; description: string; submit: string }> = {
  invite: {
    title: 'Invite someone',
    description: 'They will get a single-use link to choose their own password.',
    submit: 'Send invitation',
  },
  create: {
    title: 'Create an account',
    description: 'The account is active straight away, with the password you set here.',
    submit: 'Create account',
  },
  edit: { title: 'Edit user', description: '', submit: 'Save' },
}

const copy = computed(() => COPY[mode.value])

// Reset on open rather than on close: a dialog that clears itself while fading out shows
// the fields emptying, and reopening is the only moment the values are actually needed.
watch(
  () => props.open,
  (open) => {
    if (!open) return

    failure.value = null
    submitting.value = false
    mode.value = dialogMode(props.user, session.can)

    const user = props.user
    email.value = user?.email ?? ''
    name.value = user?.name ?? ''
    password.value = ''
    roleIds.value = user?.roles.map((role) => role.roleId) ?? []
  },
  { immediate: true },
)

/**
 * A password nobody has to invent.
 *
 * `crypto.getRandomValues` rather than `Math.random`, and an alphabet of **exactly 64**
 * characters so a byte can be masked down to an index with `& 63` — 256 divides by 64, so
 * every character is equally likely. Any other length reintroduces modulo bias, which is
 * why the count is stated rather than left to be noticed.
 *
 * `i`, `l`, `I`, `O`, `0` and `1` are absent: this value gets read out loud and typed by
 * hand at least once before it is changed.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz' + 'ABCDEFGHJKLMNPQRSTUVWXYZ' + '23456789' + '#@%*-_+=?'

function generate(): void {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  password.value = Array.from(bytes, (byte) => ALPHABET[byte & 63]).join('')
}

async function submit(): Promise<void> {
  if (submitting.value) return

  if (roleIds.value.length === 0) {
    failure.value = local('Pick at least one role — an account without one cannot open anything.')
    return
  }

  // Checked here as well as in the API: "at least 8 characters" is a rule that can be
  // answered without a round trip. The API still enforces it — this is only politeness.
  if (mode.value === 'create' && password.value.length < 8) {
    failure.value = local('Use at least 8 characters for the password.')
    return
  }

  submitting.value = true
  failure.value = null

  const result = await send()

  submitting.value = false

  if ('failure' in result) {
    failure.value = result.failure
    return
  }

  emit('saved', result.data)
  emit('update:open', false)
}

/** The one place the mode turns into a route. Three endpoints, three permissions, one form. */
function send(): Promise<ActionResult<UserSaved>> {
  const trimmed = { email: email.value.trim(), name: name.value.trim(), roleIds: roleIds.value }
  const user = props.user

  if (user !== null) return updateUser(user.id, { name: trimmed.name, roleIds: trimmed.roleIds })
  if (mode.value === 'create') return createUser({ ...trimmed, password: password.value })
  return inviteUser(trimmed)
}

function local(message: string): ApiFailure {
  return { code: 'validation_failed', message, status: 0 }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ copy.title }}</DialogTitle>
        <DialogDescription>
          <template v-if="mode === 'edit'">{{ user?.email }}</template>
          <template v-else>{{ copy.description }}</template>
        </DialogDescription>
      </DialogHeader>

      <!--
        Only for somebody holding both keys. With one, there is nothing to choose and a
        switch with a single working half is a control that teaches the wrong thing.
      -->
      <div v-if="modes.length > 1" class="bg-muted flex gap-1 rounded-lg p-1">
        <Button
          v-for="option in modes"
          :key="option"
          type="button"
          size="sm"
          class="flex-1"
          :variant="mode === option ? 'secondary' : 'ghost'"
          :disabled="submitting"
          @click="mode = option"
        >
          {{ option === 'invite' ? 'Send an invitation' : 'Set a password' }}
        </Button>
      </div>

      <form class="space-y-4" novalidate @submit.prevent="submit">
        <div v-if="mode !== 'edit'" class="space-y-2">
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

        <div v-if="mode === 'create'" class="space-y-2">
          <Label for="user-password">Password</Label>
          <div class="flex gap-2">
            <!--
              Shown rather than masked, on purpose: it is being chosen *for* somebody else
              and has to be read back out to them. Hiding it would only mean typing it twice
              and hoping.
            -->
            <Input
              id="user-password"
              v-model="password"
              type="text"
              autocomplete="off"
              spellcheck="false"
              class="font-mono"
              minlength="8"
              required
            />
            <Button type="button" variant="secondary" :disabled="submitting" @click="generate">
              <RefreshCw />
              <span class="sr-only">Generate a password</span>
            </Button>
          </div>
          <p class="text-muted-foreground text-xs">
            At least 8 characters. Give it to them yourself — this is the only place it is shown.
          </p>
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
            {{ copy.submit }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
