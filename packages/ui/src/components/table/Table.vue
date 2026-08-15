<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

/**
 * The wrapper scrolls horizontally rather than the page, so a wide table on a phone
 * never drags the whole layout sideways with it.
 */
const props = defineProps<{
  class?: HTMLAttributes['class']
  containerClass?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    data-slot="table-container"
    :class="cn('relative w-full overflow-x-auto', props.containerClass)"
  >
    <table data-slot="table" :class="cn('w-full caption-bottom text-sm', props.class)">
      <slot />
    </table>
  </div>
</template>
