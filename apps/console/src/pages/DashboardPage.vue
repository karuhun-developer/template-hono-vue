<script setup lang="ts">
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@app/ui'

import HealthCard from '@/components/HealthCard.vue'
import { useSessionStore } from '@/stores/session'

/**
 * The overview.
 *
 * It shows who you are signed in as and what you are allowed to do, because in a starter
 * that is the genuinely useful answer — and it is the first thing anybody checks while
 * setting up accounts. Replace it with whatever your application's landing screen is;
 * nothing else depends on this page.
 */
const session = useSessionStore()
</script>

<template>
  <div class="space-y-5">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">
        Hello, {{ session.user?.name ?? 'there' }}
      </h2>
      <p class="text-muted-foreground text-sm">{{ session.user?.email }}</p>
    </div>

    <!-- Side by side where there is room; the cards are short and neither is the main one. -->
    <div class="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Your access</CardTitle>
          <CardDescription>
            Recalculated from the server every time the console is opened — never stored in the
            browser.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3 text-sm">
          <div class="flex items-center justify-between gap-3">
            <span class="text-muted-foreground">Permissions</span>
            <Badge variant="secondary">{{ session.permissions.length }}</Badge>
          </div>
          <div v-if="session.permissions.length > 0" class="flex flex-wrap gap-2 pt-1">
            <Badge v-for="permission in session.permissions" :key="permission" variant="outline">
              {{ permission }}
            </Badge>
          </div>
          <p v-else class="text-muted-foreground">
            No permissions yet. Ask an administrator to give your account a role.
          </p>
        </CardContent>
      </Card>

      <HealthCard />
    </div>
  </div>
</template>
