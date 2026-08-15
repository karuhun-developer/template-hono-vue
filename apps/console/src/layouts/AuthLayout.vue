<script setup lang="ts">
import { Command } from '@lucide/vue'

import ThemeToggle from '@/components/ThemeToggle.vue'

/**
 * The frame around the pages you can reach without a session: signing in and accepting an
 * invitation.
 *
 * Two panels. The left one is the product — a name, and one sentence saying what is behind
 * the form — and it is `hidden lg:flex`, because on a phone a decorative half-screen is
 * something you scroll past to reach the fields. The right one is the form, and it stays
 * the same width at every size so the two pages that use this cannot drift apart.
 *
 * Both pages sit inside this rather than each drawing its own centred card: they are the
 * first screen anybody sees of an application built from this template, and a sign-in page
 * that does not match the invitation page is the first thing that looks unfinished.
 */
defineProps<{ heading: string; description: string }>()
</script>

<template>
  <div class="grid min-h-dvh lg:grid-cols-2">
    <!--
      `bg-muted` rather than `bg-primary`: in the zinc palette the primary is near-black in
      light mode and near-white in dark, so a panel painted with it would turn into a white
      slab at night — the one screen where that is least welcome.
    -->
    <div class="bg-muted relative hidden flex-col justify-between border-r p-10 lg:flex">
      <div class="flex items-center gap-2 text-lg font-medium">
        <span
          class="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg"
        >
          <Command class="size-4" />
        </span>
        Console
      </div>

      <blockquote class="space-y-2">
        <p class="text-lg leading-relaxed">
          Accounts, roles and a trail of who changed what — the part every project rebuilds, already
          built.
        </p>
        <footer class="text-muted-foreground text-sm">Hono + Vue template</footer>
      </blockquote>
    </div>

    <div class="relative flex items-center justify-center px-4 py-10">
      <!-- Here as well as in the shell: signing in at night should not start with a flash. -->
      <div class="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div class="w-full max-w-sm space-y-6">
        <div class="space-y-1">
          <h1 class="text-2xl font-semibold tracking-tight">{{ heading }}</h1>
          <p class="text-muted-foreground text-sm">{{ description }}</p>
        </div>

        <slot />
      </div>
    </div>
  </div>
</template>
