<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <ul
    data-slot="sidebar-menu-sub"
    :class="
      cn(
        'border-sidebar-border mx-3.5 flex min-w-0 flex-col gap-0.5 border-l px-2.5 py-0.5',
        'group-data-[state=collapsed]:hidden',
        props.class,
      )
    "
  >
    <slot />
  </ul>
</template>
