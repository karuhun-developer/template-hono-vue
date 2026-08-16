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
 * Following a password reset link.
 *
 * Public on purpose, and for the same reason accepting an invitation is: whoever opens it
 * cannot sign in. The capability is the token in the URL, not a session. So the page calls
 * `GET /auth/password-reset/:token` first — a link that has been used, superseded or has
 * expired says so *before* somebody invents a password rather than after.
 *
 * Setting the password revokes every other session, which the API does and this page
 * announces. "I forgot my password" and "I think somebody else has my password" arrive
 * through this same door, and only one of them is safe to leave signed in elsewhere.
 */

type Reset = InferResponseType<(typeof api.auth)['password-reset'][':token']['$get']>['reset']

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const token = computed(() => String(route.params['token'] ?? ''))

const reset = ref<Reset | null>(null)
const loading = ref(true)
const failure = ref<ApiFailure | null>(null)

const password = ref('')
const confirmation = ref('')
const submitting = ref(false)

const expiry = computed(() =>
  reset.value === null ? '' : formatDateTime(reset.value.expiresAt, ''),
)

/** The heading says which of the three states this page is in before anything else does. */
const heading = computed(() => {
  if (loading.value) return 'Set a new password'
  return reset.value ? 'Set a new password' : 'This link is no longer valid'
})

const description = computed(() => {
  if (loading.value) return 'Checking the link you followed.'
  if (reset.value) {
    return `Choose a new password for ${reset.value.email}. Everywhere else that account is signed in will be signed out.`
  }

  return 'Reset links expire within the hour, and asking for a new one replaces the old. Request another from the sign-in page.'
})

onMounted(async () => {
  try {
    const response = await api.auth['password-reset'][':token'].$get({
      param: { token: token.value },
    })

    if (!response.ok) {
      failure.value = await readApiError(response)
      return
    }

    reset.value = (await response.json()).reset
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
    const response = await api.auth['reset-password'].$post({
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

    <form v-else-if="reset" class="space-y-4" novalidate @submit.prevent="submit">
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
        {{ submitting ? 'Setting up…' : 'Set the password and sign in' }}
      </Button>

      <p v-if="expiry" class="text-muted-foreground text-center text-xs">
        This link is valid until {{ expiry }}.
      </p>
    </form>

    <!--
      A dead link gets no "try again" button: reloading it will never change the answer.
      What does help is asking for another one, which is the sign-in page.
    -->
    <div v-else class="space-y-3">
      <FailureAlert :failure="failure" />
      <Button variant="outline" class="w-full" @click="router.replace(LOGIN_PATH)">
        Go to the sign-in page
      </Button>
    </div>
  </AuthLayout>
</template>
