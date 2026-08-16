<script setup lang="ts">
import { Button, Input, Label } from '@app/ui'
import { LoaderCircle } from '@lucide/vue'
import { onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import AuthLayout from '@/layouts/AuthLayout.vue'
import { safeRedirect } from '@/lib/access'
import type { ApiFailure } from '@/lib/api-error'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const email = ref('')
const password = ref('')
const submitting = ref(false)
const failure = ref<ApiFailure | null>(null)

// A live session does not need a form. This happens when somebody presses "back" after
// signing in, or opens an old bookmark of /login.
onMounted(async () => {
  await session.ensureReady()
  if (session.isAuthenticated) await router.replace(safeRedirect(route.query['next']))
})

async function submit(): Promise<void> {
  if (submitting.value) return

  submitting.value = true
  failure.value = null

  const result = await session.login({ email: email.value.trim(), password: password.value })

  submitting.value = false

  if (result) {
    failure.value = result
    // The password is cleared, the email is not. Retyping an address after every typo in
    // a password is a punishment with no purpose.
    password.value = ''
    return
  }

  await router.replace(safeRedirect(route.query['next']))
}
</script>

<template>
  <AuthLayout heading="Sign in" description="Use the account you were invited with.">
    <form class="space-y-4" novalidate @submit.prevent="submit">
      <div class="space-y-2">
        <Label for="email">Email</Label>
        <Input
          id="email"
          v-model="email"
          type="email"
          autocomplete="username"
          autocapitalize="none"
          spellcheck="false"
          placeholder="owner@example.com"
          required
        />
      </div>

      <div class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <Label for="password">Password</Label>
          <RouterLink
            to="/forgot-password"
            class="text-muted-foreground hover:text-foreground text-xs"
          >
            Forgot your password?
          </RouterLink>
        </div>
        <Input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
        />
      </div>

      <!--
        The sentence comes from the API as it is. A failed sign-in deliberately does not
        distinguish "no such email" from "wrong password" — that difference is the cheapest
        way to find out who has an account here.
      -->
      <p
        v-if="failure"
        role="alert"
        class="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm"
      >
        {{ failure.message }}
      </p>

      <Button type="submit" class="w-full" :disabled="submitting">
        <LoaderCircle v-if="submitting" class="animate-spin" />
        {{ submitting ? 'Checking…' : 'Sign in' }}
      </Button>
    </form>
  </AuthLayout>
</template>
