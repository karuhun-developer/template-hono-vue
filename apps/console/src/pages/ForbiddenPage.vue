<script setup lang="ts">
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@app/ui'
import { ShieldOff } from '@lucide/vue'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useSessionStore } from '@/stores/session'

/**
 * The "you do not have access" page.
 *
 * The refused address is shown as it is, deliberately: the person reading this has just
 * been told they lack access, and the next question is always "access to what?". Hiding
 * the address only moves that conversation into a longer chat message.
 */
const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const from = computed(() => {
  const value = route.query['from']
  return typeof value === 'string' ? value : null
})
</script>

<template>
  <div class="bg-muted/40 flex min-h-dvh items-center justify-center px-4 py-10">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <ShieldOff class="text-muted-foreground size-6" />
        <CardTitle>Access denied</CardTitle>
        <CardDescription>
          {{ session.user?.email ?? 'Your account' }} does not have access to this page.
          <template v-if="from"> ({{ from }})</template>
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-2">
        <Button class="w-full" @click="router.replace('/')">Back to the overview</Button>
        <p class="text-muted-foreground text-xs">
          If this looks wrong, ask an administrator to add the permission to one of your roles.
        </p>
      </CardContent>
    </Card>
  </div>
</template>
