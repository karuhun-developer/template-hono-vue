<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

/**
 * The content column. `min-w-0` is what stops a wide table from pushing the sidebar off
 * the screen — a flex child defaults to `min-width: auto`, which means "as wide as my
 * content", which means the table wins.
 */
const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <main
    data-slot="sidebar-inset"
    :class="cn('bg-background relative flex min-h-dvh w-full min-w-0 flex-1 flex-col', props.class)"
  >
    <slot />
  </main>
</template>
