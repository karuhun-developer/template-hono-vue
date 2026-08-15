<script setup lang="ts">
import { Button, Input, Label, Skeleton } from '@app/ui'
import { LoaderCircle } from '@lucide/vue'
import type { InferResponseType } from 'hono/client'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import FailureAlert from '@/components/FailureAlert.vue'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { LOGIN_PATH } from '@/lib/access'
import { api } from '@/lib/api'
import { networkFailure, readApiError, type ApiFailure } from '@/lib/api-error'
import { formatDateTime } from '@/lib/format'
import { useSessionStore } from '@/stores/session'

/**
 * Accepting an invitation — the only way a new account gets its first password.
 *
 * Public on purpose: whoever opens it does not have an active account yet. The capability
 * is the token in the URL, not a session. Which is why the page calls
 * `GET /auth/invitation/:token` first — if the link has already been used, revoked or has
 * expired, the person finds out *before* inventing a password rather than after.
 *
 * The name and the email cannot be edited here. Both were decided by whoever sent the
 * invitation; if either is wrong the invitation has to be reissued, rather than the
 * recipient quietly correcting it.
 */

type Invitation = InferResponseType<(typeof api.auth.invitation)[':token']['$get']>['invitation']

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const token = computed(() => String(route.params['token'] ?? ''))

const invitation = ref<Invitation | null>(null)
const loading = ref(true)
const failure = ref<ApiFailure | null>(null)

const password = ref('')
const confirmation = ref('')
const submitting = ref(false)

const expiry = computed(() =>
  invitation.value === null ? '' : formatDateTime(invitation.value.expiresAt, ''),
)

/** The heading says which of the three states this page is in before anything else does. */
const heading = computed(() => {
  if (loading.value) return 'Your invitation'
  return invitation.value ? `Hello, ${invitation.value.name}` : 'This invitation is not valid'
})

const description = computed(() => {
  if (loading.value) return 'Checking the link you followed.'
  if (invitation.value) {
    return `You were invited as ${invitation.value.email}. Choose a password to activate the account.`
  }

  return 'Invitation links usually expire, have already been used, or were cancelled. Ask whoever invited you to send a new one.'
})

onMounted(async () => {
  try {
    const response = await api.auth.invitation[':token'].$get({ param: { token: token.value } })
    if (!response.ok) {
      failure.value = await readApiError(response)
      return
    }

    invitation.value = (await response.json()).invitation
  } catch (error) {
    failure.value = networkFailure(error)
  } finally {
    loading.value = false
  }
})

async function submit(): Promise<void> {
  if (submitting.value) return

  // Checked here as well as in the API: "at least 8 characters" is a rule that can be
  // answered without a round trip. The API still enforces it — this is only politeness.
  if (password.value.length < 8) {
    failure.value = local('Use at least 8 characters.')
    return
  }

  if (password.value !== confirmation.value) {
    failure.value = local('The two passwords do not match yet.')
    return
  }

  submitting.value = true
  failure.value = null

  try {
    const response = await api.auth.invitation.accept.$post({
      json: { token: token.value, password: password.value },
    })

    if (!response.ok) {
      failure.value = await readApiError(response)
      password.value = ''
      confirmation.value = ''
      return
    }

    // The server has already set the cookie. `bootstrap()` fills in the permissions, so
    // the shell is never rendered from half the information — same as signing in.
    await session.bootstrap()
    await router.replace('/')
  } catch (error) {
    failure.value = networkFailure(error)
  } finally {
    submitting.value = false
  }
}

function local(message: string): ApiFailure {
  return { code: 'validation_failed', message, status: 0 }
}
</script>

<template>
  <AuthLayout :heading="heading" :description="description">
    <div v-if="loading" class="space-y-3">
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
    </div>

    <form v-else-if="invitation" class="space-y-4" novalidate @submit.prevent="submit">
      <div class="space-y-2">
        <Label for="password">New password</Label>
        <Input
          id="password"
          v-model="password"
          type="password"
          autocomplete="new-password"
          minlength="8"
          required
        />
        <p class="text-muted-foreground text-xs">At least 8 characters.</p>
      </div>

      <div class="space-y-2">
        <Label for="confirmation">Type it again</Label>
        <Input
          id="confirmation"
          v-model="confirmation"
          type="password"
          autocomplete="new-password"
          required
        />
      </div>

      <FailureAlert :failure="failure" />

      <Button type="submit" class="w-full" :disabled="submitting">
        <LoaderCircle v-if="submitting" class="animate-spin" />
        {{ submitting ? 'Setting up…' : 'Activate and sign in' }}
      </Button>

      <p v-if="expiry" class="text-muted-foreground text-center text-xs">
        This invitation is valid until {{ expiry }}.
      </p>
    </form>

    <!--
      An invalid invitation gets no "try again" button: reloading the same link will never
      change the answer. The only person who can help is whoever sent it.
    -->
    <div v-else class="space-y-3">
      <FailureAlert :failure="failure" />
      <Button variant="outline" class="w-full" @click="router.replace(LOGIN_PATH)">
        Go to the sign-in page
      </Button>
    </div>
  </AuthLayout>
</template>
