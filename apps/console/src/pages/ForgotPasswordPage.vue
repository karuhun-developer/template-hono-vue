<script setup lang="ts">
import { Button, Input, Label } from '@app/ui'
import { LoaderCircle, MailCheck } from '@lucide/vue'
import { ref } from 'vue'
import { RouterLink } from 'vue-router'

import FailureAlert from '@/components/FailureAlert.vue'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { LOGIN_PATH } from '@/lib/access'
import { api } from '@/lib/api'
import { networkFailure, readApiError, type ApiFailure } from '@/lib/api-error'

/**
 * Asking for a password reset link.
 *
 * The API answers `200 { ok: true }` whatever it found — an address with no account, one
 * that is invited or disabled or deleted, one that already asked a moment ago — so this
 * page says the same sentence in every one of those cases. Reporting "no such account"
 * would turn the form into something anybody can use to find out who has one here, which is
 * the same rule the sign-in page follows.
 *
 * Which means the only failure worth showing is one that stops the request being answered
 * at all: a malformed address (a `400`), or a network that dropped it.
 */

const email = ref('')
const submitting = ref(false)
const sent = ref(false)
const failure = ref<ApiFailure | null>(null)

async function submit(): Promise<void> {
  if (submitting.value) return

  submitting.value = true
  failure.value = null

  try {
    const response = await api.auth['forgot-password'].$post({
      json: { email: email.value.trim() },
    })

    if (!response.ok) {
      failure.value = await readApiError(response)
      return
    }

    sent.value = true
  } catch (error) {
    failure.value = networkFailure(error)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthLayout
    heading="Forgot your password?"
    description="Tell us the address you sign in with and we will send a link to set a new one."
  >
    <!--
      Deliberately vague, and deliberately not "we found your account". It is the same
      sentence for an address that has never existed here.
    -->
    <div v-if="sent" class="space-y-4">
      <div class="bg-muted flex gap-3 rounded-lg border p-4 text-sm">
        <MailCheck class="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <p>
          If <span class="font-medium">{{ email.trim() }}</span> belongs to an account, a link to
          set a new password is on its way. It expires within the hour.
        </p>
      </div>

      <RouterLink :to="LOGIN_PATH">
        <Button variant="outline" class="w-full">Back to sign in</Button>
      </RouterLink>
    </div>

    <form v-else class="space-y-4" novalidate @submit.prevent="submit">
      <div class="space-y-2">
        <Label for="email">Email</Label>
        <Input
          id="email"
          v-model="email"
          type="email"
          autocomplete="username"
          autocapitalize="none"
          spellcheck="false"
          placeholder="you@example.com"
          required
        />
      </div>

      <FailureAlert :failure="failure" />

      <Button type="submit" class="w-full" :disabled="submitting">
        <LoaderCircle v-if="submitting" class="animate-spin" />
        {{ submitting ? 'Sending…' : 'Send the link' }}
      </Button>

      <RouterLink
        :to="LOGIN_PATH"
        class="text-muted-foreground hover:text-foreground block text-center text-sm"
      >
        Back to sign in
      </RouterLink>
    </form>
  </AuthLayout>
</template>
