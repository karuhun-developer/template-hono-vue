<script setup lang="ts">
import { Button, cn } from '@app/ui'
import { CircleUser } from '@lucide/vue'
import { computed, ref } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

import AccountSheet from '@/components/AccountSheet.vue'
import { visibleItems } from '@/lib/access'
import { NAV_ITEMS } from '@/lib/nav'
import { useSessionStore } from '@/stores/session'

/**
 * The back office shell.
 *
 * The breakpoint is `md`: below it a bottom bar (thumbs), above it a sidebar (a mouse).
 * Not two components copying each other's contents — one `NAV_ITEMS` list rendered twice
 * in different arrangements, so adding a menu item never means adding it in two places and
 * forgetting one.
 */
const route = useRoute()
const session = useSessionStore()

const accountOpen = ref(false)
const items = computed(() => visibleItems(NAV_ITEMS, { permissions: session.permissions }))

const isActive = (to: string): boolean =>
  to === '/' ? route.path === '/' : route.path.startsWith(to)
</script>

<template>
  <div class="bg-background text-foreground min-h-dvh md:flex">
    <!-- Sidebar (>= md) -->
    <aside class="border-border hidden w-60 shrink-0 flex-col border-r md:flex">
      <div class="border-border border-b px-4 py-4">
        <p class="text-sm font-semibold">Console</p>
        <p class="text-muted-foreground text-xs">Back office</p>
      </div>

      <nav class="flex-1 space-y-1 p-3">
        <RouterLink
          v-for="item in items"
          :key="item.to"
          :to="item.to"
          :class="
            cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive(item.to)
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )
          "
        >
          <component :is="item.icon" class="size-4" />
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="border-border border-t p-3">
        <Button variant="ghost" class="w-full justify-start" @click="accountOpen = true">
          <CircleUser />
          <span class="truncate">{{ session.user?.name ?? 'Account' }}</span>
        </Button>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <!-- Mobile header (< md) -->
      <header
        class="border-border bg-background/95 sticky top-0 z-10 flex items-center gap-3 border-b px-4 py-3 backdrop-blur md:hidden"
      >
        <p class="min-w-0 flex-1 truncate text-sm font-semibold">Console</p>
        <Button variant="ghost" size="icon" aria-label="Account" @click="accountOpen = true">
          <CircleUser />
        </Button>
      </header>

      <!--
        The bottom padding leaves room for the bottom bar plus the iPhone safe area.
        Without it the last row of a table is permanently covered by the navigation, with
        nothing left to scroll.
      -->
      <main class="flex-1 px-4 py-4 pb-[calc(5rem+env(safe-area-inset-bottom))] md:px-6 md:pb-6">
        <RouterView />
      </main>
    </div>

    <!-- Bottom bar (< md) -->
    <nav
      class="border-border bg-background/95 fixed inset-x-0 bottom-0 z-10 flex border-t pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <RouterLink
        v-for="item in items"
        :key="item.to"
        :to="item.to"
        :class="
          cn(
            'flex flex-1 flex-col items-center gap-1 py-3 text-xs font-medium transition-colors',
            isActive(item.to) ? 'text-primary' : 'text-muted-foreground',
          )
        "
      >
        <component :is="item.icon" class="size-5" />
        {{ item.label }}
      </RouterLink>
    </nav>

    <AccountSheet v-model:open="accountOpen" />
  </div>
</template>
