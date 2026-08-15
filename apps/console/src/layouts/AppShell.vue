<script setup lang="ts">
import { Separator, SidebarInset, SidebarProvider, SidebarTrigger } from '@app/ui'
import { computed } from 'vue'
import { RouterView, useRoute } from 'vue-router'

import AppSidebar from '@/components/AppSidebar.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'

/**
 * The back office shell.
 *
 * There is one navigation and one arrangement of it. Below `md` the sidebar renders itself
 * into a sheet — the previous shell had a sidebar *and* a bottom bar, each rendering the
 * same list its own way, which works until the first nested item arrives that four
 * thumb-sized tabs cannot express.
 *
 * The heading comes from `route.meta.title`, the same string the tab title is built from,
 * so a page named once is named everywhere.
 */
const route = useRoute()

const title = computed(() => route.meta.title ?? 'Console')
</script>

<template>
  <SidebarProvider>
    <AppSidebar />

    <SidebarInset>
      <header
        class="bg-background/95 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur"
      >
        <SidebarTrigger class="-ml-1" />
        <Separator orientation="vertical" class="mr-1 h-4" />
        <h1 class="min-w-0 flex-1 truncate text-sm font-medium">{{ title }}</h1>
        <ThemeToggle />
      </header>

      <div class="flex-1 px-4 py-5 md:px-6 md:py-6">
        <RouterView />
      </div>
    </SidebarInset>
  </SidebarProvider>
</template>
