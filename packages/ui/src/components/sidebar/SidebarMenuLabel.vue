<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

/**
 * The text half of a menu button. Collapses to zero width on the rail instead of
 * unmounting, so the row slides rather than reflowing.
 */
const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <span
    data-slot="sidebar-menu-label"
    :class="
      cn(
        'min-w-0 flex-1 truncate transition-opacity duration-200',
        'group-data-[state=collapsed]:w-0 group-data-[state=collapsed]:opacity-0',
        props.class,
      )
    "
  >
    <slot />
  </span>
</template>
